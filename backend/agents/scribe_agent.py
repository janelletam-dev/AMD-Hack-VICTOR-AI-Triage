"""S.C.R.I.B.E. — Clinical Note Writer.

Maintains a running SOAP note across the triage encounter. Update on
every meaningful event (final transcript, biomarker, concordance flag).

Latency budget: <2s per update.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from services.vllm_service import ChatMessage, LLMUnavailable, VLLMService

log = logging.getLogger("victor.agent.scribe")

PROMPT = (Path(__file__).parent.parent / "prompts" / "scribe_system.txt").read_text()


@dataclass
class SOAPNote:
    subjective: str = ""
    objective: str = ""
    assessment: str = ""
    plan: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# Strip markdown code fences if a smaller model wraps JSON in ```json … ```.
_FENCE_RE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL)


def _parse_soap(text: str) -> dict | None:
    """Best-effort parse of the LLM's SOAP JSON output."""
    if not text:
        return None
    s = text.strip()
    m = _FENCE_RE.match(s)
    if m:
        s = m.group(1).strip()
    # Sometimes models emit prefatory prose; pull the first {...} block.
    if not s.startswith("{"):
        start = s.find("{")
        end = s.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        s = s[start : end + 1]
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return None


class ScribeAgent:
    name = "S.C.R.I.B.E."

    def __init__(self, llm: VLLMService) -> None:
        self.llm = llm
        self.note = SOAPNote()

    async def update(self, context: dict) -> SOAPNote:
        """Merge new context into the running SOAP note.

        `context` keys we use:
          transcript:     str   — running concatenated patient transcript
          biomarkers:     dict  — { helios: { stress, distress, ... } }
          flags:          list  — concordance flags (raw + glossed)
          esi:            dict  — { standard, adjusted, reason }
        """
        try:
            user = (
                "Update the SOAP note with this new context. Preserve prior "
                "content; merge new information. Output JSON only.\n\n"
                f"Prior note: {json.dumps(self.note.to_dict())}\n\n"
                f"New context:\n{json.dumps(context, default=str)}"
            )
            text = await self.llm.chat(
                [
                    ChatMessage(role="system", content=PROMPT),
                    ChatMessage(role="user", content=user),
                ],
                temperature=0.2,
                max_tokens=600,
            )
            parsed = _parse_soap(text)
            if not parsed:
                raise ValueError("scribe LLM did not return valid JSON")
            plan = parsed.get("plan")
            if isinstance(plan, str):
                # Defensive: split a string plan on common separators.
                plan = [p.strip() for p in re.split(r"[\n;,]", plan) if p.strip()]
            elif not isinstance(plan, list):
                plan = []
            self.note = SOAPNote(
                subjective=str(parsed.get("subjective") or self.note.subjective),
                objective=str(parsed.get("objective") or self.note.objective),
                assessment=str(parsed.get("assessment") or self.note.assessment),
                plan=plan or self.note.plan,
            )
            return self.note
        except (LLMUnavailable, ValueError) as e:
            log.info("scribe fallback (LLM unavailable): %s", e)
            return self._fallback_update(context)

    # Cap the subjective section to prevent infinite appending when patient talks a lot.
    MAX_SUBJECTIVE_CHARS = 800

    def _fallback_update(self, context: dict) -> SOAPNote:
        """Deterministic, template-based SOAP merge when the LLM is offline.

        Builds the Subjective from the running transcript, the Objective from
        biomarkers, the Assessment from the highest-tier flag, and a sane
        default Plan when concordance has fired.
        """
        transcript = str(context.get("transcript") or "").strip()
        biomarkers = context.get("biomarkers") or {}
        flags = context.get("flags") or []
        esi = context.get("esi") or {}

        if transcript:
            self.note.subjective = (
                f"Patient reports: {transcript}"[:self.MAX_SUBJECTIVE_CHARS]
            )
        helios = biomarkers.get("helios") if isinstance(biomarkers, dict) else None
        if isinstance(helios, dict) and helios:
            parts = []
            for k in ("stress", "distress", "mentalStrain", "exhaustion"):
                if k in helios and isinstance(helios[k], (int, float)):
                    parts.append(f"{k} {helios[k]:.2f}")
            if parts:
                self.note.objective = "Helios — " + ", ".join(parts) + "."

        if flags:
            top = sorted(flags, key=lambda f: f.get("tier", 99))[0]
            label = top.get("triage_label") or top.get("trigger_phrase") or "concordance flag"
            tier = top.get("tier")
            self.note.assessment = (
                f"Tier {tier} concordance flag: {label}. "
                f"Atypical CVD presentation — recommend reassessment."
            )
            if not self.note.plan:
                self.note.plan = [
                    "Bedside 12-lead ECG",
                    "Stat troponin",
                    "Telemetry monitoring",
                    "Cardiology consult if elevated",
                ]

        if esi:
            std = esi.get("standard")
            adj = esi.get("adjusted")
            if std and adj and adj < std and "ESI" not in self.note.assessment:
                self.note.assessment += f" V.I.C.T.O.R. ESI {std} → {adj}."

        return self.note
