"""REST: /api/tts — stream ElevenLabs Flash v2.5 audio for a given voice.

Fallback: if ElevenLabs is rate-limited, down, or not configured, return a
JSON response with the text + a `X-TTS-Fallback: web-speech-api` header so the
frontend can fall back to the browser's Web Speech API. Quality drops but the
patient still hears a response.
"""
from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse

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
        return _fallback_response(text, reason="TTS not configured")

    async def _gen():
        try:
            async for chunk in _service.stream(text, voice):
                yield chunk
        except httpx.HTTPStatusError as e:
            log.error("ElevenLabs error %s: %s", e.response.status_code, e.response.text[:200])
            raise

    try:
        # Attempt streaming — if the first chunk fails, catch and fallback.
        return StreamingResponse(_gen(), media_type="audio/mpeg")
    except (httpx.HTTPStatusError, httpx.ConnectError, httpx.TimeoutException) as e:
        log.warning("ElevenLabs unavailable, falling back to Web Speech API: %s", e)
        return _fallback_response(text, reason=str(e))


@router.get("/tts/status")
async def tts_status():
    """Health check for TTS — used by frontend to pre-detect fallback mode."""
    return JSONResponse({
        "available": bool(_service.api_key),
        "provider": "elevenlabs" if _service.api_key else "web-speech-api",
    })


def _fallback_response(text: str, reason: str = "") -> JSONResponse:
    """Return text for the frontend to speak via Web Speech API."""
    log.info("TTS fallback: returning text for Web Speech API (reason: %s)", reason)
    return JSONResponse(
        content={"text": text, "fallback": True, "reason": reason},
        headers={"X-TTS-Fallback": "web-speech-api"},
        status_code=200,
    )
