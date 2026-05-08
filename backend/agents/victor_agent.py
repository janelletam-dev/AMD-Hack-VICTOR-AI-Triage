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
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from engine.concordance import ConcordanceFlag, detect_safety_escalation
from engine.triage_logic import adjust_esi
from services.event_bus import bus
from services.vllm_service import ChatMessage, LLMUnavailable, VLLMService

if TYPE_CHECKING:  # avoid import cycles at runtime
    from agents.jackie_agent import JackieAgent
    from agents.merced_agent import MercedAgent
    from agents.scribe_agent import ScribeAgent

log = logging.getLogger("victor.agent.victor")

PROMPT = (Path(__file__).parent.parent / "prompts" / "victor_system.txt").read_text()


def _utterance_window(transcript: str, phrase: str, radius: int = 200) -> str:
    """Return a window of ``transcript`` centred on ``phrase`` so the
    dashboard's gap card can quote the patient WITH the matched phrase
    visible — not just the last 400 chars (which may be a JACKIE
    follow-up answer that doesn't contain the minimisation phrase).

    Falls back to the last 400 chars when phrase is empty or not
    located, preserving the previous behaviour as a safety net.
    """
    if not transcript:
        return ""
    if not phrase:
        return transcript[-400:]
    idx = transcript.lower().find(phrase.lower())
    if idx == -1:
        return transcript[-400:]
    start = max(0, idx - radius)
    end = min(len(transcript), idx + len(phrase) + radius)
    snippet = transcript[start:end].strip()
    if start > 0:
        snippet = "…" + snippet
    if end < len(transcript):
        snippet = snippet + "…"
    return snippet


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
        transcript: str = "",
    ) -> dict:
        """Return the ESI decision as a dict suitable for the WS event.

        The numerical adjustment is deterministic (engine.triage_logic). The
        LLM only writes the one-sentence `reason` when an adjustment fired,
        so a model failure can't break the score.

        Re-runs detect_safety_escalation() on the transcript and feeds it
        into adjust_esi so V.I.C.T.O.R.'s output respects the ESI-2 floor
        for chest pain / SOB / cardiac concern. Without this, the WS-level
        safety_escalation event would publish ESI 2 once, and then this
        routine's later esi_update would silently overwrite it (e.g. with
        ESI 4 when only a Tier-4 verbal-minimisation flag fired).
        """
        safety_escalated = detect_safety_escalation(transcript) is not None
        decision = adjust_esi(chief_complaint_label, flags, safety_escalated=safety_escalated)
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
            # No concordance flags — still publish a default ESI so the
            # dashboard isn't stuck on "Awaiting evidence" for cases like
            # the ankle-pain negative control. Standard ESI defaults to 3
            # via _DEFAULT_STANDARD_ESI lookup; adjusted = standard with
            # "No adjustment" reason. Then update SOAP and exit.
            esi_default = await self.decide_esi(None, [], transcript=transcript)
            await bus.publish(
                room,
                {
                    "type": "esi_update",
                    "data": {
                        "standard_esi": esi_default["standard"],
                        "victor_esi": esi_default["adjusted"],
                        "adjustment_reason": esi_default["reason"],
                        "agent": self.name,
                    },
                },
            )
            await self._scribe_step(room, transcript, biomarkers, [], esi_default, patient_ctx)
            return

        # 1. Glossify each flag in parallel.
        await self._activity(room, self.merced.name, "active", "Generating clinical gloss")
        flag_dicts = [self._flag_to_dict(f) for f in flags]
        glosses = await asyncio.gather(
            *(self.merced.gloss(d) for d in flag_dicts),
            return_exceptions=True,
        )
        # Build per-flag "biomarker evidence" — the specific axes that
        # were breaching when this flag fired. Mirrors TrueVoice's
        # `biomarker_evidence: [{name, value, ts_ms}]` shape so the
        # dashboard's Concordance Report can show the smoking-gun
        # numbers next to the patient quote.
        helios = (biomarkers or {}).get("helios") or {}
        apollo = (biomarkers or {}).get("apollo") or {}
        psyche = (biomarkers or {}).get("psyche") or {}
        breaching = self._extract_breaching_axes(helios, apollo, psyche)

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
                        # Concordance Gap context (TrueVoice-style):
                        # the patient utterance window centred on the
                        # matched phrase + the breaching biomarker
                        # snapshot at the moment the flag fired. The
                        # dashboard renders these as a "quote + matched
                        # phrase + voice at this moment + clinical
                        # note" report.
                        "utterance_text": _utterance_window(
                            transcript, d.get("trigger_phrase", "")
                        ),
                        "biomarker_evidence": breaching,
                        "ts_ms": int(time.time() * 1000),
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
        esi = await self.decide_esi(chief_complaint_label, flags, transcript=transcript)
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

    # Per-axis thresholds for "breaching" (matches the sensitivity used
    # by the TrueVoice concordance engine for direct comparability and
    # reads naturally on a 0–1 gauge: anything ≥ this is flagged).
    # Helios distress / stress / lse threshold is intentionally lower
    # than the documented "concerning ≥ 0.66" because the demo
    # population skews to the moderate range.
    _BREACH_THRESHOLDS: dict[str, dict[str, float]] = {
        "helios": {
            "stress":          0.35,
            "distress":        0.30,
            "exhaustion":      0.30,
            "lowSelfEsteem":   0.30,
            "mentalStrain":    0.35,
            "sleepPropensity": 0.40,
        },
        "apollo": {
            # Apollo's negative-leaning axes: low valence + low energy +
            # low engagement read as concerning. Arousal is bidirectional.
        },
        "psyche": {
            # Psyche emits a distribution; we treat sad/fear/anger ≥ 0.55 as breaching.
        },
    }

    @classmethod
    def _extract_breaching_axes(
        cls,
        helios: dict[str, float],
        apollo: dict[str, float],
        psyche: dict,
    ) -> list[dict[str, Any]]:
        """Return the list of biomarker axes currently above their
        breach threshold. Used as evidence chips in the Concordance
        Report panel: each entry = {name, value, model}."""
        out: list[dict[str, Any]] = []
        for axis, thresh in cls._BREACH_THRESHOLDS["helios"].items():
            v = helios.get(axis)
            if isinstance(v, (int, float)) and v >= thresh:
                out.append({"model": "helios", "name": axis, "value": round(float(v), 2)})
        # Apollo: low valence, low energy, low engagement, OR very high arousal
        if apollo:
            val = apollo.get("valence")
            if isinstance(val, (int, float)) and val <= 0.30:
                out.append({"model": "apollo", "name": "low valence", "value": round(float(val), 2)})
            eng = apollo.get("engagement")
            if isinstance(eng, (int, float)) and eng <= 0.40:
                out.append({"model": "apollo", "name": "low engagement", "value": round(float(eng), 2)})
            energy = apollo.get("energy")
            if isinstance(energy, (int, float)) and energy <= 0.30:
                out.append({"model": "apollo", "name": "low energy", "value": round(float(energy), 2)})
            arousal = apollo.get("arousal")
            if isinstance(arousal, (int, float)) and arousal >= 0.85:
                out.append({"model": "apollo", "name": "high arousal", "value": round(float(arousal), 2)})
        # Psyche: dominant negative emotion at ≥ 0.55 confidence is
        # particularly concerning when the verbal channel was positive
        # ("I'm fine" + dominant=fear is the textbook concordance gap).
        if psyche:
            distribution = psyche.get("distribution") or {}
            for emo in ("fear", "sadness", "anger"):
                w = distribution.get(emo, 0.0)
                if isinstance(w, (int, float)) and w >= 0.40:
                    out.append({"model": "psyche", "name": emo, "value": round(float(w), 2)})
        return out
