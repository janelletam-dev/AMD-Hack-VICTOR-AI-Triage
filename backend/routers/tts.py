"""REST: /api/tts — stream ElevenLabs Flash v2.5 audio for a given voice."""
from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from services.tts_service import TTSService, VoiceName

log = logging.getLogger("victor.tts.router")
router = APIRouter(prefix="/api", tags=["tts"])

_service = TTSService()


@router.get("/tts")
async def tts(
    text: str = Query(..., min_length=1, max_length=2000),
    voice: VoiceName = Query("victor"),
):
    if not _service.api_key:
        raise HTTPException(status_code=503, detail="TTS not configured")

    async def _gen():
        try:
            async for chunk in _service.stream(text, voice):
                yield chunk
        except httpx.HTTPStatusError as e:
            log.error("ElevenLabs error %s: %s", e.response.status_code, e.response.text[:200])
            raise

    return StreamingResponse(_gen(), media_type="audio/mpeg")
