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


# Canonical medical-term map for de-duplication on the "Associated symptoms"
# line. The LoRA frequently emits the same condition under multiple aliases
# (e.g. "Hypertension, High blood pressure, High blood pressure") because
# the patient verbalises one form and the model echoes both the spoken and
# clinical names. Normalise to a canonical form before deduping.
_TERM_SYNONYMS: dict[str, str] = {
    "hypertension": "Hypertension",
    "high blood pressure": "Hypertension",
    "htn": "Hypertension",
    "hbp": "Hypertension",
    "elevated bp": "Hypertension",
    "diabetes": "Diabetes",
    "diabetes mellitus": "Diabetes",
    "dm": "Diabetes",
    "type 2 diabetes": "Diabetes",
    "type ii diabetes": "Diabetes",
    "t2dm": "Diabetes",
    "myocardial infarction": "Prior MI",
    "mi": "Prior MI",
    "heart attack": "Prior MI",
    "high cholesterol": "Hyperlipidemia",
    "hyperlipidemia": "Hyperlipidemia",
    "hld": "Hyperlipidemia",
    "family history of cad": "Family history of CVD",
    "family history of cvd": "Family history of CVD",
    "family hx mi": "Family history of CVD",
    "smoker": "Smoking",
    "smoking": "Smoking",
}


def _canonicalise_term(term: str) -> str:
    key = term.strip().lower().rstrip(".")
    return _TERM_SYNONYMS.get(key, term.strip())


def _dedupe_associated_symptoms(subjective: str) -> str:
    """Find the 'Associated symptoms:' line and dedupe synonym variants.

    Operates only on a single line — leaves the rest of the subjective
    untouched. Preserves order of first appearance (deterministic).
    Returns subjective unchanged if the line is absent.
    """
    lines = subjective.splitlines()
    out: list[str] = []
    changed = False
    for line in lines:
        m = re.match(r"^(\s*Associated symptoms:\s*)(.*)$", line, re.IGNORECASE)
        if not m:
            out.append(line)
            continue
        prefix, body = m.group(1), m.group(2).strip()
        if not body or body.lower() in ("n/a", "none", "—", "-"):
            out.append(line)
            continue
        seen: set[str] = set()
        canon: list[str] = []
        for raw in re.split(r"\s*,\s*", body):
            term = _canonicalise_term(raw)
            key = term.lower()
            if not term or key in seen:
                continue
            seen.add(key)
            canon.append(term)
        out.append(f"{prefix}{', '.join(canon) if canon else 'n/a'}")
        if canon != [t.strip() for t in re.split(r"\s*,\s*", body) if t.strip()]:
            changed = True
    if not changed:
        return subjective
    return "\n".join(out)


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
          gender:         str   — sex at birth, captured at kiosk
          age:            int   — derived from DOB at kiosk
        """
        try:
            # Demographics header — pinned at the TOP of the user message
            # so the LoRA cannot miss them inside the JSON blob. Without
            # this, the MIMIC-IV-trained model (predominantly male CVD
            # corpus) hallucinates "36-year-old male" for chest pain
            # presentations even when the kiosk captured female. Live
            # calibration on 2026-05-07 surfaced this bias directly.
            gender = context.get("gender")
            age = context.get("age")
            demo_lines: list[str] = []
            if age is not None:
                demo_lines.append(f"  age: {age}")
            if gender:
                demo_lines.append(f"  sex_at_birth: {gender}")
            demographics_header = (
                "PATIENT DEMOGRAPHICS (use these EXACTLY in the Subjective "
                "demographic opener — do NOT infer from chief complaint, "
                "do NOT default to male):\n"
                + ("\n".join(demo_lines) if demo_lines else "  (not provided — omit demographic opener entirely)")
                + "\n\n"
            )
            user = (
                demographics_header
                + "Update the SOAP note with this new context. Preserve "
                "prior content; merge new information. Output JSON only.\n\n"
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
                subjective=_dedupe_associated_symptoms(
                    str(parsed.get("subjective") or self.note.subjective)
                ),
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
        # Bedside clinician addendum — vitals, exam, additional history,
        # bedside differential, plan additions. When present, replaces
        # the "[Bedside reassessment required]" placeholders with real
        # findings and tags clinician-attributed sections so the chart
        # reader can see who contributed what.
        addendum = context.get("clinician_addendum") or {}
        cl_vitals_summary = (addendum.get("vitals_summary") or "").strip()
        cl_physical_exam = (addendum.get("physical_exam") or "").strip()
        cl_additional_hx = (addendum.get("additional_history") or "").strip()
        cl_bedside_assess = (addendum.get("bedside_assessment") or "").strip()
        cl_plan_addendum = addendum.get("plan_addendum") or []
        cl_name = (addendum.get("clinician") or "").strip()

        # ── S(ubjective) — ED-grade structured HPI ────────────────────────
        # Mirrors the prompt's section markers so the offline backfill
        # produces the same shape the LLM is asked to produce. This is the
        # safety-net path; the LLM normally writes the more polished version.
        if not self.note.subjective.strip():
            lines: list[str] = []
            cc_phrase = cc_short or (cc_text[:80] if cc_text else "")
            if cc_phrase:
                lines.append(f"CHIEF COMPLAINT: {cc_phrase}")
            if esi:
                adj = esi.get("adjusted")
                std = esi.get("standard")
                if adj and std and adj < std:
                    lines.append(f"TRIAGE: ESI Level {adj} (V.I.C.T.O.R. adjusted from {std})")
                elif adj or std:
                    lines.append(f"TRIAGE: ESI Level {adj or std}")
            lines.append("ARRIVAL: Self-presented to voice kiosk")
            lines.append("")
            lines.append("HISTORY OF PRESENT ILLNESS:")
            demo_phrase = []
            if age is not None:
                demo_phrase.append(f"{age}-year-old")
            if gender:
                demo_phrase.append(str(gender).lower())
            opener = (" ".join(demo_phrase) + " " if demo_phrase else "Patient ") + "presenting"
            if cc_phrase:
                opener += f" with {cc_phrase.lower()}"
            opener += "."
            lines.append(opener)
            if cc_text:
                lines.append(f"Patient narrative: \"{cc_text[:300]}\"")
            else:
                lines.append("Detailed OPQRST history pending JACKIE follow-up.")
            if pert_negs:
                lines.append("")
                lines.append(
                    "PERTINENT NEGATIVES: Denies "
                    + ", ".join(str(n) for n in pert_negs[:10])
                    + "."
                )
            if cl_additional_hx:
                lines.append("")
                attribution = f" (Clinician: {cl_name})" if cl_name else " (Clinician)"
                lines.append(f"ADDITIONAL HISTORY{attribution}:")
                lines.append(cl_additional_hx)
            self.note.subjective = "\n".join(lines)[: self.MAX_SUBJECTIVE_CHARS]

        # ── O(bjective) — voice biomarkers + explicit bedside placeholders ──
        if not self.note.objective.strip():
            helios = biomarkers.get("helios") if isinstance(biomarkers, dict) else None
            parts: list[str] = []
            bucket_label = lambda v: (
                "low" if v < 0.25 else "mod-low" if v < 0.5
                else "mod-high" if v < 0.75 else "high"
            )
            if isinstance(helios, dict):
                for k in ("stress", "distress", "mentalStrain", "exhaustion", "lowSelfEsteem"):
                    v = helios.get(k)
                    if isinstance(v, (int, float)):
                        parts.append(f"{k} {v:.2f} ({bucket_label(v)})")
            attribution = f" (Clinician: {cl_name})" if cl_name else " (Clinician)"
            if cl_vitals_summary:
                obj_lines = [f"VITAL SIGNS{attribution}: {cl_vitals_summary}"]
            else:
                obj_lines = ["VITAL SIGNS: [Bedside reassessment required]"]
            if cl_physical_exam:
                obj_lines.append(
                    f"PHYSICAL EXAMINATION{attribution}: {cl_physical_exam}"
                )
            else:
                obj_lines.append(
                    "PHYSICAL EXAMINATION: [Clinician to complete at bedside]"
                )
            if parts:
                obj_lines.append(
                    "VOICE BIOMARKERS (Helios · wellness profile, not regulated medical device):"
                )
                obj_lines.append("  " + ", ".join(parts) + ".")
            else:
                obj_lines.append("VOICE BIOMARKERS: capture in progress.")
            obj_lines.append(
                "KIOSK OBSERVATION: Patient alert, conversant via voice triage; "
                "no acute distress on remote interaction."
            )
            self.note.objective = "\n".join(obj_lines)

        # ── A(ssessment) — numbered differential + MDM complexity ─────────
        if not self.note.assessment.strip():
            assess_lines: list[str] = []
            anchor = cc_short or (cc_text[:80] if cc_text else "")
            if flags:
                top = sorted(flags, key=lambda f: f.get("tier", 99))[0]
                label = top.get("triage_label") or "Atypical presentation"
                tier = top.get("tier", 3)
                assess_lines.append(f"1. {label or 'Working differential'}")
                assess_lines.append(f"   - Clinical presentation: {anchor or 'see HPI'}")
                assess_lines.append(
                    f"   - V.I.C.T.O.R. concordance: Tier {tier} flag — "
                    f"verbal-acoustic mismatch suggests under-triage risk"
                )
                assess_lines.append("")
                assess_lines.append("DIFFERENTIAL DIAGNOSES CONSIDERED:")
                assess_lines.append("- ACS (typical or atypical): to be evaluated")
                assess_lines.append("- Aortic dissection: low pretest probability")
                assess_lines.append("- PE: pending DVT/risk-factor screen")
                assess_lines.append("- Pericarditis: pending ECG + exam")
            elif anchor:
                assess_lines.append(f"1. Working differential anchored on: {anchor}")
                assess_lines.append("   - Clinical evaluation pending bedside assessment")
            else:
                assess_lines.append("1. Differential pending clinician evaluation")

            mdm = "MODERATE"
            if esi:
                adj = esi.get("adjusted") or esi.get("standard") or 3
                if adj <= 2 and flags:
                    mdm = "HIGH"
                elif adj >= 4:
                    mdm = "LOW"
            assess_lines.append("")
            assess_lines.append(f"MEDICAL DECISION-MAKING: {mdm} COMPLEXITY")
            mdm_reason = []
            if esi.get("adjusted") and esi.get("standard") and esi["adjusted"] < esi["standard"]:
                mdm_reason.append("ESI escalation")
            if flags:
                mdm_reason.append("active concordance flag")
            mdm_reason.append("clinician confirmation required")
            assess_lines.append("Justification: " + ", ".join(mdm_reason) + ".")

            if cl_bedside_assess:
                attribution = f"Dr. {cl_name}" if cl_name else "Bedside clinician"
                assess_lines.append("")
                assess_lines.append(f"CLINICIAN BEDSIDE ASSESSMENT ({attribution}):")
                assess_lines.append(cl_bedside_assess)

            # Coding placeholder — never emit ICD-10/SNOMED inline. Direct
            # LLM emission of clinical codes is a known hallucination class
            # (R07.9 vs I20.9 vs I21.4 for chest-pain syndromes are NOT
            # interchangeable). V2 verifier (Atgenomix sentence-transformer
            # embedding lookup against curated CMS ICD-10 table) closes the
            # loop with verified codes the clinician confirms.
            assess_lines.append("")
            assess_lines.append(
                "Coding: pending clinician verification "
                "(V2: embedding-verifier suggests ICD-10 codes; "
                "SNOMED concept tags applied to FHIR Bundle resources)."
            )

            self.note.assessment = "\n".join(assess_lines)

        # ── P(lan) — numbered ED workup with disposition + handoff items ──
        if not self.note.plan:
            cc_lower = (cc_short or cc_text or "").lower()
            is_cardiac = bool(flags) or any(
                k in cc_lower for k in ("chest", "cardiac", "heart", "pressure")
            )
            is_abdominal = any(k in cc_lower for k in ("abdom", "stomach", "belly"))
            is_neuro = any(k in cc_lower for k in ("headache", "head pain", "weak", "numb"))
            if is_cardiac:
                self.note.plan = [
                    "Bedside 12-lead ECG (target: door-to-ECG <10 min)",
                    "Stat troponin; repeat in 6h",
                    "Continuous cardiac monitoring + serial 12-leads",
                    "ASA 324mg PO if not contraindicated and not given pre-arrival",
                    "Cardiology consult if troponin elevated or ECG concerning",
                    "Disposition: admit to telemetry vs CCU pending workup",
                    "Code status: confirm at bedside",
                    "Critical care time: clinician to document",
                ]
            elif is_abdominal:
                self.note.plan = [
                    "NPO pending evaluation",
                    "IV access; bedside vitals + glucose",
                    "CBC, BMP, LFTs, lipase, lactate, urinalysis",
                    "Pregnancy test for female of childbearing age",
                    "CT abdomen/pelvis with contrast if surgical abdomen suspected",
                    "Surgical consult if peritoneal signs or imaging concerning",
                    "Disposition: pending workup; admit vs OR vs discharge",
                    "Critical care time: clinician to document",
                ]
            elif is_neuro:
                self.note.plan = [
                    "Bedside neuro exam + GCS",
                    "Non-contrast head CT if SAH or stroke concern",
                    "POC glucose; rule out metabolic cause",
                    "Stroke protocol if onset <4.5h and focal signs",
                    "Disposition: pending imaging + neuro consult criteria",
                    "Critical care time: clinician to document",
                ]
            else:
                self.note.plan = [
                    "Bedside vitals + clinician evaluation",
                    "Targeted history and exam per chief complaint",
                    "Workup per attending judgment after bedside assessment",
                    "Disposition: pending workup",
                    "Critical care time: clinician to document",
                ]
        # Append clinician plan additions AFTER V.I.C.T.O.R. items so the
        # chart reader can see which actions came from the bedside provider.
        # Done outside the "if not self.note.plan" guard so a follow-on
        # addendum POST stacks new items even if the AI plan already exists.
        if cl_plan_addendum:
            existing = list(self.note.plan or [])
            for item in cl_plan_addendum:
                tagged = item if item.lstrip().startswith("(Clinician)") else f"(Clinician) {item}"
                if tagged not in existing:
                    existing.append(tagged)
            self.note.plan = existing
