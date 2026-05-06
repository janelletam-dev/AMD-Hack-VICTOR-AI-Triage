"""V.I.C.T.O.R. — Triage Leader (orchestrator).

Routes events from the concordance engine to the right agent and
publishes the resulting events to the room's EventBus. Also makes the
final ESI-adjustment decision (deterministic via engine.triage_logic;
prose explanation via the LLM).

Latency target: <500ms decision routing.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from engine.concordance import ConcordanceFlag
from engine.triage_logic import adjust_esi
from services.event_bus import bus
from services.vllm_service import ChatMessage, LLMUnavailable, VLLMService

if TYPE_CHECKING:  # avoid import cycles at runtime
    from agents.jackie_agent import JackieAgent
    from agents.merced_agent import MercedAgent
    from agents.scribe_agent import ScribeAgent

log = logging.getLogger("victor.agent.victor")

PROMPT = (Path(__file__).parent.parent / "prompts" / "victor_system.txt").read_text()


class VictorAgent:
    """The orchestrator — both an agent (makes ESI decisions) and the
    swarm router (delegates to M.E.R.C.E.D., S.C.R.I.B.E., J.A.C.K.I.E.).
    """

    name = "V.I.C.T.O.R."

    def __init__(
        self,
        llm: VLLMService,
        merced: "MercedAgent",
        scribe: "ScribeAgent",
        jackie: "JackieAgent",
    ) -> None:
        self.llm = llm
        self.merced = merced
        self.scribe = scribe
        self.jackie = jackie

    # --- ESI decision ------------------------------------------------------

    async def decide_esi(
        self,
        chief_complaint_label: str | None,
        flags: list[ConcordanceFlag],
    ) -> dict:
        """Return the ESI decision as a dict suitable for the WS event.

        The numerical adjustment is deterministic (engine.triage_logic). The
        LLM only writes the one-sentence `reason` when an adjustment fired,
        so a model failure can't break the score.
        """
        decision = adjust_esi(chief_complaint_label, flags)
        result = {
            "standard": decision.standard,
            "adjusted": decision.adjusted,
            "reason": decision.reason,
        }
        if decision.adjusted < decision.standard and flags:
            try:
                tier = min(f.tier for f in flags)
                signal = flags[0].biomarker_signal
                user = (
                    f"Flags fired (tier {tier}); biomarker signal: {signal}.\n"
                    f"Standard ESI: {decision.standard} → adjusted: {decision.adjusted}.\n"
                    "Write ONE sentence (<25 words) explaining the escalation "
                    "for the triage nurse. No diagnosis. No abbreviations."
                )
                prose = await self.llm.chat(
                    [
                        ChatMessage(role="system", content=PROMPT),
                        ChatMessage(role="user", content=user),
                    ],
                    temperature=0.2,
                    max_tokens=80,
                )
                if prose:
                    result["reason"] = prose.splitlines()[0].strip()
            except LLMUnavailable as e:
                log.info("victor reason fallback: %s", e)
        return result

    # --- Routing -----------------------------------------------------------

    async def on_concordance_evaluation(
        self,
        room: str,
        flags: list[ConcordanceFlag],
        transcript: str,
        biomarkers: dict,
        chief_complaint_label: str | None = None,
        chief_complaint_text: str | None = None,
        pertinent_negatives: list[str] | None = None,
        gender: str | None = None,
        age: int | None = None,
    ) -> None:
        """Run the post-Helios pipeline:
            1. M.E.R.C.E.D. glosses each flag → publish concordance_flag events
            2. V.I.C.T.O.R. computes ESI → publish esi_update event
            3. S.C.R.I.B.E. updates SOAP → publish soap_update event
        Each step also emits agent_activity for the swarm panel.
        """
        # Bundle the optional patient context into a single dict that
        # threads through the SOAP update — keeps _scribe_step's
        # signature small while letting SCRIBE compose a real HPI.
        patient_ctx = {
            "chief_complaint_text": chief_complaint_text,
            "pertinent_negatives": pertinent_negatives or [],
            "gender": gender,
            "age": age,
        }
        if not flags:
            # No concordance — still update SOAP from transcript + biomarkers.
            await self._scribe_step(room, transcript, biomarkers, [], None, patient_ctx)
            return

        # 1. Glossify each flag in parallel.
        await self._activity(room, self.merced.name, "active", "Generating clinical gloss")
        flag_dicts = [self._flag_to_dict(f) for f in flags]
        glosses = await asyncio.gather(
            *(self.merced.gloss(d) for d in flag_dicts),
            return_exceptions=True,
        )
        for d, gloss in zip(flag_dicts, glosses):
            if isinstance(gloss, Exception):
                log.warning("merced gloss raised: %s", gloss)
                gloss_text = d.get("gloss_seed") or ""
            else:
                gloss_text = gloss
            await bus.publish(
                room,
                {
                    "type": "concordance_flag",
                    "data": {
                        **d,
                        "gloss": gloss_text,
                        "evidence_basis": (
                            f"MIMIC-IV: mean acuity {d['acuity']:.2f} for "
                            f"{d['triage_label'].lower()} in CVD cohort."
                        ),
                        "signal_summary": d["biomarker_signal"],
                        "confidence": 0.9 if d["tier"] <= 2 else 0.7,
                        "agent": self.merced.name,
                    },
                },
            )
        await self._activity(room, self.merced.name, "idle", "Gloss complete")

        # 2. ESI decision.
        await self._activity(room, self.name, "active", "Adjusting ESI")
        esi = await self.decide_esi(chief_complaint_label, flags)
        await bus.publish(
            room,
            {
                "type": "esi_update",
                "data": {
                    "standard_esi": esi["standard"],
                    "victor_esi": esi["adjusted"],
                    "adjustment_reason": esi["reason"],
                    "agent": self.name,
                },
            },
        )
        await self._activity(room, self.name, "idle", f"ESI {esi['standard']} → {esi['adjusted']}")

        # 3. SOAP update.
        await self._scribe_step(room, transcript, biomarkers, flag_dicts, esi, patient_ctx)

    async def _scribe_step(
        self,
        room: str,
        transcript: str,
        biomarkers: dict,
        flags: list[dict],
        esi: dict | None,
        patient_ctx: dict | None = None,
    ) -> None:
        await self._activity(room, self.scribe.name, "active", "Updating SOAP note")
        # Merge patient_ctx (chief complaint text, pertinent negatives,
        # demographics) into the SCRIBE context so the Subjective field
        # is composed as a real HPI paragraph with positives + negatives
        # — see prompts/scribe_system.txt for the format spec.
        ctx = {
            "transcript": transcript,
            "biomarkers": biomarkers,
            "flags": flags,
            "esi": esi or {},
        }
        if patient_ctx:
            for k, v in patient_ctx.items():
                if v is not None and v != [] and v != "":
                    ctx[k] = v
        note = await self.scribe.update(ctx)
        await bus.publish(
            room,
            {
                "type": "soap_update",
                "data": {**note.to_dict(), "ready": True, "agent": self.scribe.name},
            },
        )
        await self._activity(room, self.scribe.name, "idle", "SOAP updated")

    async def _activity(self, room: str, agent: str, status: str, action: str) -> None:
        await bus.publish(
            room,
            {
                "type": "agent_activity",
                "data": {"agent": agent, "status": status, "action": action},
            },
        )

    @staticmethod
    def _flag_to_dict(f: ConcordanceFlag) -> dict[str, Any]:
        return {
            "tier": f.tier,
            "trigger_phrase": f.trigger_phrase,
            "triage_label": f.triage_label,
            "acuity": f.acuity,
            "biomarker_signal": f.biomarker_signal,
            "gloss_seed": f.gloss_seed,
            "risk_factors": list(f.risk_factors),
            "risk_aware": f.risk_aware,
            "repeated": f.repeated,
        }
