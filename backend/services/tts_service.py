"""ElevenLabs TTS — Victor + Jackie voices (Flash v2.5)."""
from __future__ import annotations

import logging
from typing import AsyncIterator, Literal

import httpx

from config import settings

log = logging.getLogger("victor.tts")

VoiceName = Literal["victor", "jackie"]

ELEVEN_BASE = "https://api.elevenlabs.io/v1/text-to-speech"
MODEL_ID = "eleven_flash_v2_5"


class TTSService:
    def __init__(self) -> None:
        self.api_key = settings.elevenlabs_api_key
        self.voices: dict[str, str] = {
            "victor": settings.elevenlabs_voice_victor,
            "jackie": settings.elevenlabs_voice_jackie,
        }
        if not self.api_key:
            log.warning("ELEVENLABS_API_KEY not set — TTS disabled")

    def _voice_id(self, voice: VoiceName) -> str:
        vid = self.voices.get(voice)
        if not vid:
            raise ValueError(f"voice '{voice}' has no ELEVENLABS_VOICE_* configured")
        return vid

    async def stream(self, text: str, voice: VoiceName) -> AsyncIterator[bytes]:
        """Yield MP3 chunks from ElevenLabs Flash v2.5."""
        if not self.api_key:
            return
        voice_id = self._voice_id(voice)
        url = f"{ELEVEN_BASE}/{voice_id}/stream"
        headers = {
            "xi-api-key": self.api_key,
            "accept": "audio/mpeg",
            "content-type": "application/json",
        }
        body = {
            "text": text,
            "model_id": MODEL_ID,
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            async with client.stream("POST", url, headers=headers, json=body) as r:
                r.raise_for_status()
                async for chunk in r.aiter_bytes():
                    if chunk:
                        yield chunk
