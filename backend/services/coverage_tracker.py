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


# Canonical question text per element — used as the deterministic fallback
# when JACKIE's LLM-generated turn would re-ask covered ground. Phrased in
# plain conversational English (no clinical jargon — patients hear these).
_ELEMENT_QUESTIONS: dict[str, str] = {
    "onset":        "When did this first start?",
    "severity":     "On a scale of 1 to 10, how would you rate the pain right now?",
    "quality":      "Can you describe what it feels like — sharp, dull, pressure, burning?",
    "region":       "Where exactly is it bothering you?",
    "radiation":    "Does it move anywhere else — your jaw, arm, back, or shoulder?",
    "associated":   "Any other symptoms with it — sweating, nausea, shortness of breath?",
    "aggravating": "Is there anything that makes it worse?",
    "alleviating": "Have you tried anything that makes it better?",
    "setting":     "What were you doing when this started?",
    "pmh":         "Any health conditions we should know about — diabetes, high blood pressure, or heart problems?",
    "medications": "Are you taking any medications right now?",
    "allergies":   "Any allergies we should know about, especially to medications?",
    "lmp":         "When was your last menstrual period?",
}


# Question patterns that indicate a JACKIE turn is asking about a particular
# element. Matched against JACKIE's OUTPUT (her question to the patient).
# Tighter than ELEMENTS (which matches patient *answers*) because question
# phrasing is more bounded — onset is "when did/how long", severity is "rate /
# scale of 1 to 10", etc. This is the redundancy detector's classifier.
_QUESTION_PATTERNS: dict[str, list[str]] = {
    "onset":     [r"\bwhen did", r"\bhow long", r"\b(suddenly|gradually)\b"],
    "severity":  [r"\b(rate|scale)\b", r"\b1\s*(?:to|-)\s*10\b", r"\bhow (?:bad|severe)\b"],
    "quality":   [r"\b(what does it feel|describe.*feel)\b", r"\b(sharp|dull|pressure|burning|stabbing|crushing)\b"],
    "region":    [r"\bwhere\s+(?:exactly|does it|is)\b", r"\bpoint to\b"],
    "radiation": [r"\b(radiat|move|spread|go(?:es)?\s+(?:down|to|into))\b"],
    "associated":[r"\b(any other (?:symptom|problem)|along\s+with)\b", r"\b(nausea|vomit|sweat|shortness|dizz|fever)\b\?"],
    "aggravating":[r"\b(make[s]?\s+it\s+worse|worse\s+(?:when|with))\b"],
    "alleviating":[r"\b(make[s]?\s+it\s+better|tried anything|relieved)\b"],
    "pmh":       [r"\bhealth conditions?\b", r"\b(diabetes|high blood pressure|heart problems|cardiac history)\b\?"],
    "medications":[r"\bmedications?\b", r"\btaking any (?:meds|drug|pill)\b"],
    "allergies": [r"\ballerg"],
    "lmp":       [r"\b(last menstrual|last period|lmp)\b"],
}


def classify_question_element(question: str) -> str | None:
    """Classify which OPQRST/SAMPLE element a JACKIE question targets.

    Returns the element name (e.g. 'onset', 'severity') or None if the
    question doesn't cleanly map to an element (open-ended acknowledgements,
    closing turns, edge cases). When None, the redundancy filter should
    let the question pass — better to risk a missed redundancy than to
    silently rewrite a thoughtful contextual probe.
    """
    if not question or not question.strip():
        return None
    q = question.lower()
    best: tuple[str, int] | None = None
    for name, patterns in _QUESTION_PATTERNS.items():
        hits = sum(1 for p in patterns if re.search(p, q, re.IGNORECASE))
        if hits and (best is None or hits > best[1]):
            best = (name, hits)
    return best[0] if best else None


def replace_if_redundant(
    question: str,
    covered: set[str],
    remaining: list[str],
) -> tuple[str, bool]:
    """If `question` re-asks an element already covered, swap it for the
    canonical question on the first uncovered element from `remaining`.

    Returns (final_question, was_replaced). When no redundancy is detected,
    or no remaining element has a canonical question, the original is
    returned unchanged.
    """
    target = classify_question_element(question)
    if not target or target not in covered:
        return question, False
    for name in remaining:
        if name in covered:
            continue
        canonical = _ELEMENT_QUESTIONS.get(name)
        if canonical:
            return canonical, True
    return question, False


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
