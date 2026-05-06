"""Coverage tracker for J.A.C.K.I.E.'s clinical follow-up loop.

Pure logic module — the clinical knowledge (element regexes, NegEx
concepts, priority orderings) lives in `services.clinical_knowledge`.
This file just walks the conversation history with that knowledge and
returns three things J.A.C.K.I.E. needs per turn:

  1. extract_covered(history)    → set of elements the patient mentioned
  2. extract_negatives(history)  → list of explicit denials (NegEx)
  3. priority_order(...)          → ordered list of remaining elements,
                                    biased by chief complaint

Everything is deterministic + regex-based. No LLM. The output flows
into J.A.C.K.I.E.'s per-turn prompt as "COVERAGE SO FAR / NEXT
PRIORITIES / DENIED" hints, and into S.C.R.I.B.E.'s context so the
HPI paragraph weaves pertinent negatives inline.
"""
from __future__ import annotations

import re
from typing import Iterable

from services.clinical_knowledge import (
    ELEMENTS,
    NEGATIVE_CONCEPTS,
    DEFAULT_ORDER,
    CARDIAC_ORDER,
    ABDOMINAL_ORDER,
    HEADACHE_ORDER,
    SOB_ORDER,
)


def extract_covered(history: Iterable[dict]) -> set[str]:
    """Return the set of element names that have been mentioned across
    the patient's utterances in the conversation history.

    Only patient turns are scanned — J.A.C.K.I.E. asking about quality
    doesn't mean the patient answered.
    """
    text = " ".join(
        h.get("text", "").lower()
        for h in (history or [])
        if h.get("role") == "patient"
    )
    if not text.strip():
        return set()
    covered: set[str] = set()
    for name, patterns in ELEMENTS.items():
        for p in patterns:
            if re.search(p, text, re.IGNORECASE):
                covered.add(name)
                break
    return covered


# NegEx-style negation triggers (Chapman et al, JBI 2001). Restricted
# to the most reliable patterns; "no" is intentionally tight (only
# "no <concept>") to avoid fabricating negatives from prose starters
# like "no, I was sitting on the couch."
_NEGATION_TRIGGERS = (
    r"\b(?:no|denies?|deny|denied|denying|without|negative\s+for|"
    r"haven'?t\s+had|hasn'?t\s+had|don'?t\s+have|doesn'?t\s+have|"
    r"never\s+had|not\s+had|no\s+history\s+of)\b"
)

# Pseudo-negation triggers — phrases that LOOK like negation but
# don't negate a clinical concept. We block these so the kiosk
# doesn't fabricate negatives from filler.
_PSEUDO_NEGATION_BLOCKLIST = (
    "no further", "no change", "not necessarily", "not only",
    "no doubt", "no problem", "not sure", "not really",
)


def extract_negatives(history: Iterable[dict]) -> list[str]:
    """Return a deduplicated list of pertinent negatives mentioned by
    the patient — concepts they explicitly DENIED having.

    Examples:
        "I haven't had any chest pain"   → ["chest pain"]
        "no SOB, no diaphoresis"         → ["SOB", "diaphoresis"]
        "denies radiation to the arm"    → ["radiation"]
        "no, I was sitting on couch"     → []  (pseudo-negation)

    Output is a list (not a set) so order matches the patient's
    narrative, which makes the resulting HPI paragraph read naturally.
    """
    text = " ".join(
        h.get("text", "").lower()
        for h in (history or [])
        if h.get("role") == "patient"
    )
    if not text.strip():
        return []
    found: list[str] = []
    seen: set[str] = set()
    for label, concept_re in NEGATIVE_CONCEPTS:
        if label in seen:
            continue
        # Compose: <negation trigger> <up to 6 tokens of buffer> <concept>
        pattern = (
            _NEGATION_TRIGGERS
            + r"(?:\s+\w+){0,6}\s+"
            + concept_re
        )
        for m in re.finditer(pattern, text, re.IGNORECASE):
            window = m.group(0).lower()
            if any(pseudo in window for pseudo in _PSEUDO_NEGATION_BLOCKLIST):
                continue
            seen.add(label)
            found.append(label)
            break
    return found


def priority_order(
    chief_complaint: str | None,
    gender: str | None,
    covered: set[str],
) -> list[str]:
    """Return the priority-ordered list of remaining (uncovered)
    elements for J.A.C.K.I.E. to ask about next.

    The order is biased by chief complaint: cardiac front-loads
    radiation + associated; abdominal inserts LMP for female-bodied;
    headache front-loads severity + associated neuro. Anything else
    uses the default OPQRST + SAMPLE order. Source-of-truth orderings
    are in clinical_knowledge.py.
    """
    cc = (chief_complaint or "").lower()
    if any(k in cc for k in ("chest", "heart", "pressure")):
        order = list(CARDIAC_ORDER)
    elif any(k in cc for k in ("abdom", "stomach", "belly", "gut")):
        order = list(ABDOMINAL_ORDER)
        if gender == "Female":
            # LMP front-loaded for female-bodied + abdominal pain —
            # ectopic pregnancy is a can't-miss for any abd pain in a
            # female of childbearing age.
            order.insert(3, "lmp")
    elif any(k in cc for k in ("headache", "head pain", "migraine", "head ache")):
        order = list(HEADACHE_ORDER)
    elif any(k in cc for k in (
        "breath", "breathing", "short of breath", "can't breathe", "sob"
    )):
        order = list(SOB_ORDER)
    else:
        order = list(DEFAULT_ORDER)
    return [e for e in order if e not in covered]
