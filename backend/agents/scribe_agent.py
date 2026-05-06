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
            # Even on a successful LLM response, ensure every section has
            # *something* — small models occasionally omit fields, and a
            # half-empty SOAP looks broken on the chart and the EPIC export.
            self._backfill_empty_sections(context)
            return self.note
        except (LLMUnavailable, ValueError) as e:
            log.info("scribe fallback (LLM unavailable): %s", e)
            return self._fallback_update(context)

    async def summarize_cc(self, complaint: str) -> str:
        """Distil a free-text complaint into a clinician-shorthand chief
        complaint line, e.g. "I've had this terrible chest pain for the
        last day, it kind of feels like pressure" → "Chest pain × 24h,
        pressure-like".

        Used by the clinician dashboard's IdentityCard so the "Reason for
        visit" header reads like a real ED chart entry instead of a
        verbatim narrative. The full patient narrative remains
        available verbatim via the dashboard's accordion. Latency
        budget: <1s — small max_tokens, no JSON parsing.

        Returns "" on LLM failure; the dashboard falls back to a
        truncated raw complaint in that case.
        """
        if not complaint or not complaint.strip():
            return ""
        try:
            user = (
                "Distill this patient complaint into a single chief-complaint "
                "line in clinician shorthand (the kind of line that goes in "
                "the ED chart header). Keep it under 8 words. Use clinical "
                "abbreviations where appropriate (e.g. 'x 24h', 'SOB', "
                "'RLQ'). Do NOT add a diagnosis — just describe what the "
                "patient came in for. Output the line ONLY, no preamble, "
                "no quotes.\n\n"
                "Examples:\n"
                "  Patient: \"I've had this terrible chest pain for the "
                "last day, it kind of feels like pressure\"\n"
                "  → Chest pain x 24h, pressure-like\n"
                "  Patient: \"My belly really hurts on the right side\"\n"
                "  → Abd pain RLQ\n"
                "  Patient: \"I'm short of breath when I walk up stairs\"\n"
                "  → SOB on exertion\n"
                "  Patient: \"I have the worst headache of my life\"\n"
                "  → Severe headache, sudden onset\n\n"
                f"Patient: {complaint.strip()!r}\n  →"
            )
            text = await self.llm.chat(
                [
                    ChatMessage(
                        role="system",
                        content=(
                            "You are a clinical scribe distilling patient "
                            "complaints into ED chart-header chief-complaint "
                            "lines. Be terse and clinical."
                        ),
                    ),
                    ChatMessage(role="user", content=user),
                ],
                temperature=0.1,
                max_tokens=30,
            )
            short = (text or "").strip().strip('"').strip("`").strip()
            # Strip leading "→" or "->" the model might echo from the prompt.
            short = re.sub(r"^[\-→>]+\s*", "", short)
            # First line only — sometimes the model adds a follow-up.
            short = short.split("\n", 1)[0].strip()
            # Hard cap so a verbose model doesn't pollute the chart header.
            if len(short) > 80:
                short = short[:77].rstrip() + "..."
            return short
        except (LLMUnavailable, ValueError) as e:
            log.info("scribe summarize_cc fallback (LLM unavailable): %s", e)
            # Fallback: take the first sentence, capped at 60 chars.
            first = re.split(r"[.!?\n]", complaint.strip(), maxsplit=1)[0].strip()
            if len(first) > 60:
                first = first[:57].rstrip() + "..."
            return first

    # Cap the subjective section to prevent infinite appending when patient talks a lot.
    MAX_SUBJECTIVE_CHARS = 800

    def _fallback_update(self, context: dict) -> SOAPNote:
        """Deterministic, template-based SOAP merge when the LLM is offline.

        Delegates to `_backfill_empty_sections` so the offline path uses
        exactly the same composition logic as the post-LLM cleanup.
        """
        self._backfill_empty_sections(context)
        return self.note

    def _backfill_empty_sections(self, context: dict) -> None:
        """Ensure every SOAP section carries clinically meaningful content.

        Runs after both the LLM and offline paths so the chart and the EPIC
        export never expose a half-empty note. A small model that returns
        only `{ "subjective": "..." }` would otherwise leave O/A/P blank.
        """
        transcript = str(context.get("transcript") or "").strip()
        biomarkers = context.get("biomarkers") or {}
        flags = context.get("flags") or []
        esi = context.get("esi") or {}
        cc_text = str(context.get("chief_complaint_text") or "").strip()
        cc_short = str(context.get("chief_complaint_short") or "").strip()
        pert_negs = context.get("pertinent_negatives") or []
        gender = context.get("gender")
        age = context.get("age")

        # ── S(ubjective) — HPI bullets from chief complaint + transcript ──
        if not self.note.subjective.strip():
            bullets: list[str] = []
            if cc_short:
                bullets.append(f"CC: {cc_short}")
            elif cc_text:
                bullets.append(f"CC: {cc_text[:120]}")
            demo = []
            if age is not None:
                demo.append(f"{age}yo")
            if gender:
                demo.append(str(gender).lower())
            if demo:
                bullets.append("Demographics: " + " ".join(demo))
            if transcript:
                snippet = transcript[: self.MAX_SUBJECTIVE_CHARS - 32]
                bullets.append(f"Patient narrative: {snippet}")
            if pert_negs:
                bullets.append("Denies: " + ", ".join(str(n) for n in pert_negs[:8]))
            if not bullets:
                bullets.append("Voice triage in progress; HPI pending.")
            self.note.subjective = "\n".join(f"• {b}" for b in bullets)

        # ── O(bjective) — voice biomarkers + context ──────────────────────
        if not self.note.objective.strip():
            helios = biomarkers.get("helios") if isinstance(biomarkers, dict) else None
            parts: list[str] = []
            if isinstance(helios, dict):
                for k in ("stress", "distress", "mentalStrain", "exhaustion", "lowSelfEsteem"):
                    v = helios.get(k)
                    if isinstance(v, (int, float)):
                        parts.append(f"{k} {v:.2f}")
            obj_lines = ["Vitals: deferred to bedside reassessment."]
            if parts:
                obj_lines.append("Voice biomarkers (Helios) — " + ", ".join(parts) + ".")
            else:
                obj_lines.append("Voice biomarkers: capture in progress.")
            obj_lines.append("Appearance: alert, conversant via kiosk.")
            self.note.objective = "\n".join(obj_lines)

        # ── A(ssessment) — flags / CC / ESI ───────────────────────────────
        if not self.note.assessment.strip():
            if flags:
                top = sorted(flags, key=lambda f: f.get("tier", 99))[0]
                label = top.get("triage_label") or top.get("trigger_phrase") or "concordance flag"
                tier = top.get("tier")
                self.note.assessment = (
                    f"Tier {tier} concordance flag: {label}. "
                    f"Atypical presentation — clinician reassessment recommended."
                )
            elif cc_short or cc_text:
                anchor = cc_short or cc_text[:80]
                self.note.assessment = (
                    f"Working differential anchored on chief complaint: {anchor}. "
                    f"Clinician evaluation pending."
                )
            else:
                self.note.assessment = "Differential pending clinician evaluation."
        if esi:
            std = esi.get("standard")
            adj = esi.get("adjusted")
            if std and adj and adj < std and "ESI" not in self.note.assessment:
                self.note.assessment += f" V.I.C.T.O.R. ESI {std} → {adj}."

        # ── P(lan) — flag-driven workup or default reassessment plan ──────
        if not self.note.plan:
            if flags:
                self.note.plan = [
                    "Bedside 12-lead ECG",
                    "Stat troponin",
                    "Telemetry monitoring",
                    "Cardiology consult if elevated",
                ]
            else:
                self.note.plan = [
                    "Bedside vitals + clinician evaluation",
                    "Targeted history and exam per chief complaint",
                    "Reassess after focused workup",
                ]
