"""Privacy-safe TTS filter.

V.I.C.T.O.R. should never REPEAT sensitive patient info aloud via TTS.
This module detects and redacts sensitive content from text destined for
the kiosk speaker, where other patients/visitors may overhear.

The transcript itself (for clinician dashboard / EMR) is NEVER filtered.
"""
from __future__ import annotations

import re

# Patterns that indicate sensitive content the system should not echo aloud.
_SENSITIVE_PATTERNS: list[tuple[re.Pattern, str]] = [
    # Drug use
    (re.compile(r"\b(i\s+use|i\s+take|i\s+do|i\s+smoke|i\s+inject)\s+(drugs?|meth|heroin|cocaine|crack|fentanyl|weed|marijuana|pills)\b", re.IGNORECASE),
     "Thank you for sharing that — I've noted it."),
    # HIV / STI
    (re.compile(r"\b(hiv|aids|herpes|syphilis|gonorrhea|chlamydia|std|sti)\s*(positive|negative|status)?\b", re.IGNORECASE),
     "Thank you for telling me that — it's noted in your record."),
    # Pregnancy (can be sensitive in certain contexts)
    (re.compile(r"\b(i'?m|i\s+am|i\s+might\s+be)\s+pregnant\b", re.IGNORECASE),
     "Thank you for letting me know — I've made a note of that."),
    # Abuse / violence
    (re.compile(r"\b(hit\s+me|beats?\s+me|abuse|domestic\s+violence|sexually\s+assault|raped?)\b", re.IGNORECASE),
     "I hear you, and I'm glad you told me. That's noted safely."),
    # Suicidal ideation
    (re.compile(r"\b(kill\s+myself|want\s+to\s+die|suicid|self.?harm|hurt\s+myself)\b", re.IGNORECASE),
     "Thank you for telling me that. I've flagged it so someone can help."),
    # Mental health stigmatized conditions
    (re.compile(r"\b(i'?m|i\s+am)\s+(schizophrenic|bipolar|psychotic|hearing\s+voices)\b", re.IGNORECASE),
     "Thank you for sharing that with me — it's noted."),
]


def contains_sensitive_content(text: str) -> bool:
    """Return True if the text contains content that should not be echoed aloud."""
    for pattern, _ in _SENSITIVE_PATTERNS:
        if pattern.search(text):
            return True
    return False


def redact_for_tts(text: str) -> str:
    """If text contains sensitive content, return a safe acknowledgment instead.

    Returns the original text unchanged if no sensitive patterns match.
    The clinician dashboard always sees the full unredacted transcript.
    """
    for pattern, replacement in _SENSITIVE_PATTERNS:
        if pattern.search(text):
            return replacement
    return text
