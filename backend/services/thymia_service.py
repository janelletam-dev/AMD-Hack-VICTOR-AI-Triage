"""thymia Helios voice-biomarker client.

Helios is NOT a streaming API — each "model run" is a complete recording
(min 10s, formats FLAC/MP3/MP4/Ogg/WebM/WAV) submitted via a presigned
upload URL, then polled.

Workflow (verified against https://api.thymia.ai/openapi.json):
  1. POST /v1/models/mental-wellness   → { id, recordingUploadUrl }
  2. PUT recordingUploadUrl with the WAV bytes (Content-Type: audio/wav)
  3. Poll GET /v1/models/mental-wellness/{id} every ~3s until
     status ∈ {COMPLETE_OK, COMPLETE_ERROR}.

Biomarker fields returned (per docs/helios/interpreting-results):
  stress, distress, exhaustion, sleepPropensity, lowSelfEsteem, mentalStrain
  (each as bucketed {value: 0.0|0.33|0.66|1.0}, plus uniform* continuous variants)

Notes:
- Company name is lowercase: "thymia".
- Auth header is `x-api-key` (not Authorization).
- We default to Helios only for live triage; Apollo requires two recordings
  and is out of scope for the kiosk hot path.
"""
from __future__ import annotations

import asyncio
import io
import logging
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
    stress: float = 0.0
    distress: float = 0.0
    exhaustion: float = 0.0
    sleep_propensity: float = 0.0
    low_self_esteem: float = 0.0
    mental_strain: float = 0.0
    raw: dict[str, Any] = field(default_factory=dict)

    def to_event(self) -> dict[str, Any]:
        """Shape used in the WS `biomarker` event sent to clinician views."""
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
    ) -> HeliosResult | None:
        """Run Helios on a single complete WAV recording.

        Returns parsed biomarker scores from the first analysed section, or
        None if disabled/failed. Logs (does not raise) for transport errors.
        """
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
