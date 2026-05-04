"""Deepgram Flux Multilingual STT client.

Wraps the Deepgram SDK v3 websocket API for live streaming transcription.
Audio frames (PCM16, 16kHz mono) are pushed via send(); transcript events
are dispatched to a caller-supplied callback.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Callable

from deepgram import (
    DeepgramClient,
    LiveOptions,
    LiveTranscriptionEvents,
)

from config import settings

log = logging.getLogger("victor.deepgram")


@dataclass
class Transcript:
    text: str
    language: str
    is_final: bool


class DeepgramService:
    """Per-session Deepgram streaming connection.

    Usage:
        dg = DeepgramService(on_transcript=my_callback)
        await dg.start()
        dg.send(pcm16_bytes)   # call repeatedly with audio frames
        await dg.stop()
    """

    def __init__(self, on_transcript: Callable[[Transcript], Any] | None = None) -> None:
        self.api_key = settings.deepgram_api_key
        self._on_transcript = on_transcript
        self._client: DeepgramClient | None = None
        self._conn: Any = None
        self._started = False

        if not self.api_key:
            log.warning("DEEPGRAM_API_KEY not set — STT will be disabled")

    async def start(self) -> bool:
        if not self.api_key:
            return False

        self._client = DeepgramClient(self.api_key)
        self._conn = self._client.listen.websocket.v("1")

        self._conn.on(LiveTranscriptionEvents.Transcript, self._handle_transcript)
        self._conn.on(LiveTranscriptionEvents.Error, self._handle_error)
        self._conn.on(LiveTranscriptionEvents.Open, self._handle_open)
        self._conn.on(LiveTranscriptionEvents.Close, self._handle_close)
        self._conn.on(LiveTranscriptionEvents.UtteranceEnd, self._handle_utterance_end)

        options = LiveOptions(
            model="nova-2",
            language="multi",
            encoding="linear16",
            sample_rate=settings.sample_rate_hz,
            channels=1,
            interim_results=True,
            utterance_end_ms="1500",
            smart_format=True,
            punctuate=True,
        )

        ok = self._conn.start(options)
        if ok:
            self._started = True
            log.info("deepgram connection opened")
        else:
            log.error("deepgram connection failed to start")
        return ok

    def send(self, audio_bytes: bytes) -> None:
        if self._conn and self._started:
            self._conn.send(audio_bytes)

    async def stop(self) -> None:
        if self._conn and self._started:
            self._conn.finish()
            self._started = False
            log.info("deepgram connection closed")

    def _handle_open(self, _self_notused: Any, open_resp: Any, **kwargs: Any) -> None:
        log.info("deepgram ws open")

    def _handle_close(self, _self_notused: Any, close_resp: Any, **kwargs: Any) -> None:
        log.info("deepgram ws closed")

    def _handle_error(self, _self_notused: Any, error: Any, **kwargs: Any) -> None:
        log.error("deepgram error: %s", error)

    def _handle_utterance_end(self, _self_notused: Any, utterance_end: Any, **kwargs: Any) -> None:
        log.debug("deepgram utterance end")

    def _handle_transcript(self, _self_notused: Any, result: Any, **kwargs: Any) -> None:
        try:
            alt = result.channel.alternatives[0]
            text = alt.transcript
            if not text:
                return

            is_final = bool(getattr(result, "is_final", False))
            lang = (
                getattr(result.channel, "detected_language", None)
                or getattr(alt, "language", None)
                or getattr(result, "language", None)
                or "en"
            )

            transcript = Transcript(text=text, language=lang, is_final=is_final)
            log.info("transcript [%s] final=%s: %s", lang, is_final, text)

            if self._on_transcript:
                self._on_transcript(transcript)
        except (IndexError, AttributeError) as e:
            log.warning("transcript parse error: %s", e)
