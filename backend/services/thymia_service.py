"""thymia voice-biomarker client — Helios (real) + Apollo/Psyche (synthetic).

Only **Helios** is wired to the real thymia API. Apollo and Psyche are
transcript-driven demo-mode generators that produce plausible dashboard
values without any API call. See below for why.

Helios (real — POST /v1/models/mental-wellness):
  Each "model run" is a complete recording (min 10s, WAV/FLAC/MP3/MP4/
  Ogg/WebM) submitted via a presigned upload URL, then polled.
  Returns: stress, distress, exhaustion, sleepPropensity, lowSelfEsteem,
  mentalStrain (bucketed 0.0|0.33|0.66|1.0).

Apollo (synthetic — real API is POST /v1/models/apollo):
  The real Apollo endpoint requires *two* recordings (mood-question
  response + read-aloud passage, each ≥15s) and returns depression /
  anxiety disorder scores — not valence/arousal/energy/engagement.
  The kiosk captures a single complaint recording, so Apollo's
  two-recording requirement cannot be met. The dashboard's Apollo
  values are a transcript-driven synthetic construct for demo
  visualization only.

Psyche (synthetic — no thymia API exists):
  "Psyche" is not a thymia product. The docs list Helios, Apollo, and
  Sentinel (voice-agent safety). The affect breakdown (dominant emotion
  + 7-axis distribution) shown on the dashboard is entirely synthetic,
  generated from transcript keyword matching.

Verified against https://api.thymia.ai/openapi.json (2026-05-06).
Auth header: `x-api-key`. Company name is lowercase: "thymia".
"""
from __future__ import annotations

import asyncio
import io
import logging
import re
import struct
from dataclasses import dataclass, field
from typing import Any

import httpx

from config import settings

log = logging.getLogger("victor.thymia")

THYMIA_BASE_URL = "https://api.thymia.ai"
HELIOS_CREATE = f"{THYMIA_BASE_URL}/v1/models/mental-wellness"
HELIOS_GET_TMPL = f"{THYMIA_BASE_URL}/v1/models/mental-wellness/{{run_id}}"

POLL_INTERVAL_S = 3.0
POLL_TIMEOUT_S = 90.0


@dataclass
class HeliosResult:
    """Helios = thymia mental-wellness profile (stress / distress /
    exhaustion / sleep / self-esteem / mental strain). The bias-
    detection signal for V.I.C.T.O.R.: low_self_esteem is what flips
    the under-triaged-women-in-CVD flag."""
    stress: float = 0.0
    distress: float = 0.0
    exhaustion: float = 0.0
    sleep_propensity: float = 0.0
    low_self_esteem: float = 0.0
    mental_strain: float = 0.0
    raw: dict[str, Any] = field(default_factory=dict)

    def to_event(self) -> dict[str, Any]:
        return {
            "helios": {
                "stress": self.stress,
                "distress": self.distress,
                "exhaustion": self.exhaustion,
                "sleepPropensity": self.sleep_propensity,
                "lowSelfEsteem": self.low_self_esteem,
                "mentalStrain": self.mental_strain,
            },
        }


@dataclass
class ApolloResult:
    """Apollo = thymia mood / energy profile. Continuous valence (positive
    ↔ negative), arousal (calm ↔ activated), energy, engagement. Useful
    on the dashboard for spotting flat affect (low arousal + low energy
    + negative valence) which can correlate with depression and
    minimisation patterns."""
    valence: float = 0.5      # 0 = very negative, 1 = very positive
    arousal: float = 0.5      # 0 = calm/flat, 1 = activated
    energy: float = 0.5
    engagement: float = 0.5
    raw: dict[str, Any] = field(default_factory=dict)

    def to_event(self) -> dict[str, Any]:
        return {
            "apollo": {
                "valence": self.valence,
                "arousal": self.arousal,
                "energy": self.energy,
                "engagement": self.engagement,
            },
        }


@dataclass
class PsycheResult:
    """Psyche = thymia affect breakdown. Returns a dominant emotion
    (joy / sadness / anger / fear / disgust / surprise / neutral) plus
    a confidence and a full distribution. The discrete-emotion signal
    is what populates the affect chip on the clinician dashboard.

    Important triage note: a chest-pain patient whose Psyche reads
    `dominant=fear` while their voice biomarkers (Helios) say "calm"
    is a classic atypical CVD presentation — the affect leak that
    M.E.R.C.E.D. picks up as concordance discrepancy."""
    dominant: str = "neutral"
    confidence: float = 0.0
    distribution: dict[str, float] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    def to_event(self) -> dict[str, Any]:
        return {
            "psyche": {
                "dominant": self.dominant,
                "confidence": self.confidence,
                "distribution": self.distribution,
            },
        }


class ThymiaService:
    def __init__(self) -> None:
        self.api_key = settings.thymia_api_key
        if not self.api_key:
            log.warning("THYMIA_API_KEY not set — biomarkers will be skipped")

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    async def submit_helios(
        self,
        wav_bytes: bytes,
        user_label: str,
        date_of_birth: str | None = None,
        birth_sex: str = "UNKNOWN",
        language: str = "en-US",
        transcript: str | None = None,
    ) -> HeliosResult | None:
        """Run Helios on a single complete WAV recording.

        Returns parsed biomarker scores from the first analysed section, or
        None if disabled/failed. Logs (does not raise) for transport errors.

        When `settings.demo_mode` is true, returns scripted biomarker values
        without hitting the real Thymia API — guarantees the concordance
        flag fires at demo time regardless of how the demoer actually
        sounds. If a `transcript` is supplied, the scripted baseline is
        nudged up by patient-spoken stress/exhaustion keywords ("I'm
        exhausted" → exhaustion bumps from 0.33 → 0.65) so the demo
        biomarkers respond to what the patient actually says, instead
        of staying frozen at a single canned snapshot.
        """
        if settings.demo_mode:
            return _demo_helios_result(transcript)
        if not self.enabled:
            return None
        if not wav_bytes:
            log.warning("submit_helios called with empty audio")
            return None

        headers = {"x-api-key": self.api_key, "accept": "application/json"}

        body: dict[str, Any] = {
            "user": {
                "userLabel": user_label[:50],
                "birthSex": birth_sex,
            },
            "language": language,
        }
        if date_of_birth:
            body["user"]["dateOfBirth"] = date_of_birth

        async with httpx.AsyncClient(timeout=20.0) as client:
            try:
                # 1) Create the model run
                r = await client.post(HELIOS_CREATE, headers=headers, json=body)
                r.raise_for_status()
                created = r.json()
            except httpx.HTTPError as e:
                log.error("helios create failed: %s", e)
                return None

            run_id = created.get("id")
            upload_url = created.get("recordingUploadUrl")
            if not run_id or not upload_url:
                log.error("helios create response missing fields: %s", created)
                return None

            # 2) Upload the recording (presigned URL — no x-api-key)
            try:
                up = await client.put(
                    upload_url,
                    content=wav_bytes,
                    headers={"Content-Type": "audio/wav"},
                )
                up.raise_for_status()
            except httpx.HTTPError as e:
                log.error("helios upload failed (run=%s): %s", run_id, e)
                return None

            # 3) Poll
            elapsed = 0.0
            while elapsed < POLL_TIMEOUT_S:
                await asyncio.sleep(POLL_INTERVAL_S)
                elapsed += POLL_INTERVAL_S
                try:
                    r = await client.get(
                        HELIOS_GET_TMPL.format(run_id=run_id), headers=headers
                    )
                    r.raise_for_status()
                except httpx.HTTPError as e:
                    log.warning("helios poll error (run=%s): %s", run_id, e)
                    continue

                payload = r.json()
                status = payload.get("status")
                if status == "COMPLETE_OK":
                    return _parse_helios(payload)
                if status == "COMPLETE_ERROR":
                    log.error(
                        "helios run %s failed: %s — %s",
                        run_id,
                        payload.get("errorCode"),
                        payload.get("errorReason"),
                    )
                    return None
                # CREATED or RUNNING — keep polling

            log.warning("helios poll timed out (run=%s, %.0fs)", run_id, elapsed)
            return None

    async def submit_apollo(
        self,
        wav_bytes: bytes,
        user_label: str,
        date_of_birth: str | None = None,
        birth_sex: str = "UNKNOWN",
        language: str = "en-US",
        transcript: str | None = None,
    ) -> ApolloResult | None:
        """Return synthetic Apollo values (demo) or None (production).

        The real Apollo API (POST /v1/models/apollo) requires two
        separate recordings — a mood-question response and a read-aloud
        passage, each ≥15s — and returns depression/anxiety disorder
        scores. The kiosk's single complaint recording cannot satisfy
        this, and Apollo's real output (PHQ-like severity) doesn't map
        to the dashboard's valence/arousal/energy/engagement axes.

        In demo mode we return transcript-driven synthetic values so the
        dashboard looks alive. In production we return None; the
        dashboard gracefully hides the Apollo section.
        """
        if settings.demo_mode:
            return _demo_apollo_result(transcript)
        if not self.enabled:
            return None
        log.info("apollo: synthetic only (real API needs two recordings) — returning None")
        return None

    async def submit_psyche(
        self,
        wav_bytes: bytes,
        user_label: str,
        date_of_birth: str | None = None,
        birth_sex: str = "UNKNOWN",
        language: str = "en-US",
        transcript: str | None = None,
    ) -> PsycheResult | None:
        """Return synthetic Psyche values (demo) or None (production).

        "Psyche" is not a thymia API product — the docs list Helios,
        Apollo, and Sentinel only. The affect breakdown (dominant
        emotion + 7-axis distribution) is a synthetic construct for
        dashboard visualization.

        In demo mode we return transcript-driven values. The neutral-
        leaning fallback mimics stoic/minimising patients — clinically
        high-yield because that's when M.E.R.C.E.D. should escalate.
        In production we return None; the dashboard hides this section.
        """
        if settings.demo_mode:
            return _demo_psyche_result(transcript)
        if not self.enabled:
            return None
        log.info("psyche: no thymia API exists for this — returning None")
        return None


# Demo-mode biomarker generator. Starts at a CALM-patient baseline
# (low/normal across all axes) and bumps individual axes when the
# patient surfaces matching stress/exhaustion keywords in their
# narrative (see _DEMO_TRANSCRIPT_BUMPS below). The clip-to-0.95
# ceiling avoids saturated 1.0 values that look fake on the gauges.
#
# Earlier versions of this baseline were CV-elevated (stress 0.66,
# distress 0.66, mental_strain 0.68) to drive the chest-pain demo's
# concordance flag visually. That made every patient — including the
# Scenario-2 negative-control ankle-pain patient — display concerning
# gauges. Lowering the baseline to 0.33 lets the keyword bumps drive
# elevation for actually-distressed patients (Scenario 1's
# minimisation + cardiac script still pushes values into the 0.7-0.9
# range via 3 keyword matches) while calm patients stay visibly calm.
_DEMO_BASELINE = {
    "stress":          0.33,
    "distress":        0.33,
    # Exhaustion threshold in concordance.py is 0.33 (lower than the
    # other axes since fatigue is a key atypical-CVD signal). Baseline
    # at 0.33 would fire elevation by default. Hold it below the
    # threshold so calm patients don't trigger false positives.
    "exhaustion":      0.20,
    "mental_strain":   0.33,
    "sleep_propensity": 0.0,
    "low_self_esteem": 0.0,
}

# Keyword → (axis, bump) tuples. Each phrase that fires adds its bump
# to the corresponding axis (capped at 0.95 below). Phrases are
# deliberately liberal — false positives just make the gauges read
# more concerning, which is the right failure mode for an ED triage
# kiosk where missing distress is worse than over-flagging.
_DEMO_TRANSCRIPT_BUMPS: list[tuple[str, str, float]] = [
    # Exhaustion
    (r"\b(exhaust\w*|wiped\s+out|drained|no\s+energy|so\s+tired|"
     r"can'?t\s+keep\s+going|burned?\s+out)\b",                     "exhaustion",      0.40),
    (r"\b(tired|fatigu\w+|worn\s+out)\b",                            "exhaustion",      0.20),
    # Stress / anxiety
    (r"\b(stressed?|anxious|anxiety|worried|nervous|on\s+edge|"
     r"overwhelm\w+)\b",                                              "stress",          0.20),
    (r"\b(panic\w*|freaking\s+out|losing\s+it)\b",                   "stress",          0.30),
    # Distress (acute)
    (r"\b(scared|terrified|frightened|afraid|something'?s\s+wrong|"
     r"this\s+is\s+(bad|serious))\b",                                 "distress",        0.25),
    (r"\b(can'?t\s+breathe|can'?t\s+catch\s+my\s+breath|"
     r"chest\s+(pain|tight|pressure)|crushing|elephant)\b",          "distress",        0.30),
    # Sleep
    (r"\b(haven'?t\s+slept|no\s+sleep|insomnia|can'?t\s+sleep|"
     r"awake\s+all\s+night|been\s+up\s+all\s+night)\b",              "sleep_propensity", 0.55),
    (r"\b(trouble\s+sleeping|poor\s+sleep|restless\s+night)\b",      "sleep_propensity", 0.30),
    # Mental strain
    (r"\b(can'?t\s+think|can'?t\s+focus|foggy|brain\s+fog|"
     r"confused|mind\s+racing)\b",                                    "mental_strain",   0.20),
    # Low self-esteem / minimisation (the demo's bias-detection signal)
    (r"\b(don'?t\s+want\s+to\s+bother|i'?m\s+probably\s+fine|"
     r"shouldn'?t\s+have\s+come|just\s+(me|being)|"
     r"it'?s\s+probably\s+nothing|"
     r"sorry\s+(for|to))\b",                                          "low_self_esteem", 0.45),
]


def _demo_helios_result(transcript: str | None) -> HeliosResult:
    """Compute a transcript-aware demo Helios result.

    Without a transcript (initial submission before any complaint text
    is available), returns the canned baseline. With a transcript,
    scans for keyword matches and bumps the relevant biomarker axes
    so the demo gauges respond to what the patient said. Used by
    submit_helios when settings.demo_mode is true.
    """
    scores = dict(_DEMO_BASELINE)
    if transcript:
        text = transcript.lower()
        for pattern, axis, bump in _DEMO_TRANSCRIPT_BUMPS:
            if re.search(pattern, text, re.IGNORECASE):
                scores[axis] = min(0.95, scores[axis] + bump)
    matched = [
        axis for pattern, axis, _ in _DEMO_TRANSCRIPT_BUMPS
        if transcript and re.search(pattern, transcript, re.IGNORECASE)
    ]
    log.info(
        "demo mode helios: returning scripted result (matched=%s)",
        sorted(set(matched)) or "baseline",
    )
    return HeliosResult(
        stress=scores["stress"],
        distress=scores["distress"],
        exhaustion=scores["exhaustion"],
        sleep_propensity=scores["sleep_propensity"],
        low_self_esteem=scores["low_self_esteem"],
        mental_strain=scores["mental_strain"],
        raw={"demo_mode": True, "matched_keywords": sorted(set(matched))},
    )


# Apollo (mood/energy) — transcript-aware demo. Patient comes into
# the ED → baseline valence skews negative (~0.35) and arousal varies
# by complaint (acute → high arousal, chronic → low). Keywords push
# axes from there.
_APOLLO_BASELINE = {
    "valence":    0.35,   # ED patients aren't happy by definition
    "arousal":    0.50,
    "energy":     0.55,
    "engagement": 0.65,   # they came in, so they're engaged enough
}

_APOLLO_TRANSCRIPT_BUMPS: list[tuple[str, str, float]] = [
    # Negative valence drivers
    (r"\b(scared|terrified|afraid|worried|anxious|panic\w*)\b",        "valence",    -0.20),
    (r"\b(sad|down|depress\w+|hopeless|miserable|crying)\b",            "valence",    -0.30),
    (r"\b(angry|frustrated|fed\s+up|annoyed)\b",                         "valence",    -0.15),
    (r"\b(don'?t\s+want\s+to\s+bother|probably\s+nothing|"
     r"sorry\s+(for|to))\b",                                              "valence",    -0.10),
    # Arousal drivers
    (r"\b(can'?t\s+breathe|crushing|elephant|panic\w*|"
     r"freaking\s+out)\b",                                                "arousal",    +0.30),
    (r"\b(scared|terrified|afraid)\b",                                    "arousal",    +0.20),
    (r"\b(exhaust\w+|drained|wiped\s+out|so\s+tired|"
     r"barely|can\s+hardly)\b",                                           "arousal",    -0.25),
    # Energy drivers
    (r"\b(exhaust\w+|drained|wiped\s+out|no\s+energy|"
     r"can\s+hardly\s+\w+)\b",                                            "energy",     -0.35),
    (r"\b(tired|fatigu\w+|worn\s+out)\b",                                "energy",     -0.20),
    # Engagement drivers (low when patient is dissociative or
    # over-minimising — both correlate with poor history-taking quality)
    (r"\b(don'?t\s+want\s+to\s+bother|probably\s+nothing|"
     r"i'?m\s+fine|i\s+shouldn'?t\s+(?:have\s+come|be\s+here))\b",      "engagement", -0.25),
    (r"\b(don'?t\s+remember|don'?t\s+know|i'?m\s+not\s+sure|"
     r"i\s+can'?t\s+recall)\b",                                          "engagement", -0.15),
]


def _demo_apollo_result(transcript: str | None) -> ApolloResult:
    """Compute a transcript-aware demo Apollo result. Same pattern as
    _demo_helios_result: baseline + keyword-driven axis bumps, clipped
    to [0.05, 0.95] so the gauges don't saturate at the extremes."""
    scores = dict(_APOLLO_BASELINE)
    if transcript:
        for pattern, axis, bump in _APOLLO_TRANSCRIPT_BUMPS:
            if re.search(pattern, transcript, re.IGNORECASE):
                scores[axis] = max(0.05, min(0.95, scores[axis] + bump))
    return ApolloResult(
        valence=scores["valence"],
        arousal=scores["arousal"],
        energy=scores["energy"],
        engagement=scores["engagement"],
        raw={"demo_mode": True},
    )


# Psyche (affect breakdown) — transcript-driven dominant emotion.
# Demo mode picks the most-keyword-supported emotion and assigns
# a normalised distribution. Order matters slightly: a phrase that
# matches both fear and sadness counts toward both, then we
# normalise.
_PSYCHE_EMOTION_KEYWORDS: dict[str, list[str]] = {
    "fear": [
        r"\b(scared|terrified|afraid|frightened|panic\w*|worried|"
        r"freaking\s+out|can'?t\s+breathe|"
        r"something'?s\s+(?:wrong|seriously\s+wrong))\b",
    ],
    "sadness": [
        r"\b(sad|down|depress\w+|hopeless|crying|miserable|"
        r"lonely|broken|defeated)\b",
    ],
    "anger": [
        r"\b(angry|furious|pissed|mad|frustrated|fed\s+up|"
        r"annoyed|sick\s+of)\b",
    ],
    "disgust": [
        r"\b(disgust\w+|nauseous|gross|revolting|sick\s+to\s+my\s+stomach)\b",
    ],
    "surprise": [
        r"\b(suddenly|out\s+of\s+nowhere|all\s+of\s+a\s+sudden|"
        r"didn'?t\s+see\s+(?:it|that)\s+coming|came\s+on\s+fast)\b",
    ],
    "joy": [
        r"\b(happy|glad|relieved|grateful|thank\s+you)\b",
    ],
}


def _demo_psyche_result(transcript: str | None) -> PsycheResult:
    """Compute a transcript-driven demo Psyche affect breakdown.
    Counts keyword hits per emotion, normalises to a distribution,
    picks the highest as dominant. Falls back to a neutral-leaning
    "fear-suppressed" pattern when the transcript is sparse — that's
    the typical baseline for stoic/minimising ED patients."""
    counts: dict[str, int] = {emo: 0 for emo in _PSYCHE_EMOTION_KEYWORDS}
    if transcript:
        for emo, patterns in _PSYCHE_EMOTION_KEYWORDS.items():
            for p in patterns:
                if re.search(p, transcript, re.IGNORECASE):
                    counts[emo] += 1
    total = sum(counts.values())
    if total == 0:
        # Sparse transcript → neutral-dominant with mild fear undertone.
        # This is the affect signature of stoic / minimising patients
        # ("I'm fine, it's probably nothing") — clinically high-yield
        # because it's exactly when M.E.R.C.E.D. should escalate.
        distribution = {
            "neutral":  0.55,
            "fear":     0.20,
            "sadness":  0.10,
            "anger":    0.05,
            "disgust":  0.05,
            "surprise": 0.03,
            "joy":      0.02,
        }
        return PsycheResult(
            dominant="neutral",
            confidence=0.55,
            distribution=distribution,
            raw={"demo_mode": True, "fallback": "stoic_baseline"},
        )
    # Normalise hit counts to a probability distribution. Reserve a
    # small floor for "neutral" so a one-keyword utterance doesn't
    # produce a 100%-confident dominant (that reads fake on the chart).
    distribution: dict[str, float] = {emo: 0.0 for emo in _PSYCHE_EMOTION_KEYWORDS}
    distribution["neutral"] = 0.0
    for emo, c in counts.items():
        distribution[emo] = c / total * 0.85
    distribution["neutral"] = 0.15
    dominant = max(distribution, key=distribution.get)
    confidence = distribution[dominant]
    return PsycheResult(
        dominant=dominant,
        confidence=round(confidence, 2),
        distribution={k: round(v, 2) for k, v in distribution.items()},
        raw={"demo_mode": True, "matched_counts": counts},
    )


def _parse_helios(payload: dict[str, Any]) -> HeliosResult:
    """Pull biomarker scores from the first analysed section.

    Helios returns `results.sections[]`; for the kiosk we use the first (and
    typically only) section for live display.
    """
    sections = (payload.get("results") or {}).get("sections") or []
    if not sections:
        return HeliosResult(raw=payload)
    section = sections[0]

    def v(key: str) -> float:
        node = section.get(key)
        if isinstance(node, dict):
            try:
                return float(node.get("value", 0.0) or 0.0)
            except (TypeError, ValueError):
                return 0.0
        return 0.0

    return HeliosResult(
        stress=v("stress"),
        distress=v("distress"),
        exhaustion=v("exhaustion"),
        sleep_propensity=v("sleepPropensity"),
        low_self_esteem=v("lowSelfEsteem"),
        mental_strain=v("mentalStrain"),
        raw=payload,
    )


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------

def pcm16_to_wav(pcm: bytes, sample_rate: int = 16_000, channels: int = 1) -> bytes:
    """Wrap raw little-endian PCM16 bytes in a minimal RIFF/WAVE header.

    Helios accepts WAV, so this avoids any audio re-encoding round trip.
    """
    if not pcm:
        return b""
    bits_per_sample = 16
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_size = len(pcm)
    fmt_chunk = struct.pack(
        "<4sIHHIIHH",
        b"fmt ",
        16,                     # fmt chunk size
        1,                      # PCM
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
    )
    data_chunk = struct.pack("<4sI", b"data", data_size) + pcm
    riff_size = 4 + len(fmt_chunk) + len(data_chunk)
    header = struct.pack("<4sI4s", b"RIFF", riff_size, b"WAVE")

    buf = io.BytesIO()
    buf.write(header)
    buf.write(fmt_chunk)
    buf.write(data_chunk)
    return buf.getvalue()


def dob_to_iso(dob: str | None) -> str | None:
    """Convert "January 15, 1980" or "1990-01-15" to ISO 8601 date.

    Helios expects "YYYY-MM-DD" (per OpenAPI). Returns None on parse failure.
    """
    if not dob:
        return None
    s = dob.strip()
    # Already ISO?
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        return s
    months = {
        "january": 1, "february": 2, "march": 3, "april": 4, "may": 5,
        "june": 6, "july": 7, "august": 8, "september": 9, "october": 10,
        "november": 11, "december": 12,
    }
    parts = s.replace(",", " ").split()
    if len(parts) >= 3 and parts[0].lower() in months:
        try:
            m = months[parts[0].lower()]
            d = int(parts[1])
            y = int(parts[2])
            return f"{y:04d}-{m:02d}-{d:02d}"
        except (ValueError, IndexError):
            return None
    return None
