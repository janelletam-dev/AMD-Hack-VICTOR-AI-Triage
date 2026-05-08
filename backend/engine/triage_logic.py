"""ESI scoring + V.I.C.T.O.R. adjustment logic.

Standard ESI is what a text-based triage system would produce from the
chief complaint. V.I.C.T.O.R.'s adjusted score incorporates concordance
flags + biomarker evidence.

Day 3 — used by V.I.C.T.O.R. agent for escalation decisions.
"""
from __future__ import annotations

from dataclasses import dataclass

from engine.concordance import ConcordanceFlag


@dataclass
class ESIDecision:
    standard: int
    adjusted: int
    reason: str


# Crude baseline mapping from triage label to standard ESI. Real production
# logic would use a richer taxonomy + comorbidity inputs.
_DEFAULT_STANDARD_ESI: dict[str, int] = {
    "Abdominal pain": 3,
    "Abd pain, n/v/d": 3,
    "n/v/d": 3,
    "Abd pain + diarrhea": 3,
    "ILI": 3,
    "Hypertension": 3,
    "Nausea/Vomiting": 3,
    "s/p Fall": 3,
    "Weakness": 3,
    "Epigastric pain": 3,
    "Headache": 3,
    "Leg pain": 3,
    "Verbal minimisation": 4,
}


def adjust_esi(
    chief_complaint_label: str | None,
    flags: list[ConcordanceFlag],
    safety_escalated: bool = False,
) -> ESIDecision:
    """Apply V.I.C.T.O.R.'s adjustment heuristic.

    Heuristic (Day 3 baseline):
      - Tier 1 flag → bump to ESI 2 (emergent)
      - Tier 2 flag → bump up by 1
      - Tier 3 flag → bump up by 1 only if multiple flags
      - Tier 4 flag → annotate but do not adjust

    When safety_escalated is true (the patient verbalised a hardcoded
    safety keyword like 'chest pain', 'can't breathe', 'heart attack'),
    the standard ESI is floored at 3 and the adjusted ESI capped at 2,
    regardless of which concordance flags fired. This keeps the chest-
    pain pathway intact even when Tier-2 minimisation is suppressed (so
    only Tier-4 verbal minimisation remains and would otherwise pin the
    standard to ESI 4).
    """
    standard = _DEFAULT_STANDARD_ESI.get(chief_complaint_label or "", 3)
    adjusted = standard
    reasons: list[str] = []

    if any(f.tier == 1 for f in flags):
        adjusted = min(adjusted, 2)
        reasons.append("Tier 1 concordance flag")
    elif any(f.tier == 2 for f in flags):
        adjusted = max(1, adjusted - 1)
        reasons.append("Tier 2 concordance flag")
    elif sum(1 for f in flags if f.tier == 3) >= 2:
        adjusted = max(1, adjusted - 1)
        reasons.append("Multiple Tier 3 flags")

    if safety_escalated:
        standard = max(standard, 3)
        adjusted = min(adjusted, 2)
        reasons.insert(0, "Safety keyword auto-escalation")

    if not reasons:
        reasons.append("No adjustment")

    return ESIDecision(
        standard=standard,
        adjusted=adjusted,
        reason="; ".join(reasons),
    )
