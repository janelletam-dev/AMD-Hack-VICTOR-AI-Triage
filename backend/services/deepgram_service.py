"""Deepgram Flux Multilingual STT client.

Connects directly to the v2 WebSocket endpoint (`/v2/listen`), since the
Deepgram Python SDK v3.7 only exposes v1 — and Flux requires v2.

Flux v2 protocol (probed against the live server, since public docs
were not findable at build time):
  - Connect URL: only `?model=flux-general-multi`. Audio-format query
    params (encoding, sample_rate, channels) are REJECTED with HTTP 400.
    Audio format is auto-detected from the stream.
  - Server emits `{"type":"Connected", request_id, sequence_id}` first.
  - Optional client message before audio:
        {"type":"Configure",
         "language_hints":["en","es"],     # optional
         "thresholds":{...},               # optional
         "keyterms":[...], "profanity_filter": bool}
    Server replies with `{"type":"ConfigureSuccess", ...}`.
  - Then stream raw PCM16 (16 kHz mono assumed) as binary frames.
  - To close cleanly: `{"type":"CloseStream"}` then close the WS.

Public API is identical to the previous SDK-backed version so audio_ws.py
needs no changes.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlencode

import websockets
from websockets.exceptions import ConnectionClosed

from config import settings

log = logging.getLogger("victor.deepgram")

DEEPGRAM_BASE = "wss://api.deepgram.com"
DEEPGRAM_PATH = "/v2/listen"
DEEPGRAM_MODEL = "flux-general-multi"

# Common ED-presenting languages. Improves accuracy and code-switching for
# patients who switch between e.g. English and Spanish mid-sentence.
DEFAULT_LANGUAGE_HINTS = ("en", "es")

# Bound the outbound audio queue. At 25 frames/sec (40 ms each), 2000 entries
# is ~80s of audio backlog, far beyond what we'd ever queue if the upstream
# WS is healthy. Drops on overflow are logged.
_TX_QUEUE_MAX = 2000


@dataclass
class Transcript:
    text: str
    language: str
    is_final: bool


class DeepgramService:
    """Per-session Deepgram Flux v2 streaming connection.

    Usage:
        dg = DeepgramService(on_transcript=my_callback)
        await dg.start()
        dg.send(pcm16_bytes)   # call repeatedly with audio frames
        await dg.stop()
    """

    def __init__(
        self,
        on_transcript: Callable[[Transcript], Any] | None = None,
    ) -> None:
        self.api_key = settings.deepgram_api_key
        self._on_transcript = on_transcript
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._reader_task: asyncio.Task | None = None
        self._writer_task: asyncio.Task | None = None
        self._tx_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=_TX_QUEUE_MAX)
        self._started = False
        self._dropped_frames = 0
        self._first_messages_logged = 0

        if not self.api_key:
            log.warning("DEEPGRAM_API_KEY not set — STT will be disabled")

    async def start(self) -> bool:
        if not self.api_key:
            return False

        # Flux v2 ONLY accepts `model` as a query param. Audio format is
        # auto-detected from the stream — passing encoding/sample_rate/
        # channels yields HTTP 400.
        params = {"model": DEEPGRAM_MODEL}
        url = f"{DEEPGRAM_BASE}{DEEPGRAM_PATH}?{urlencode(params)}"
        headers = {"Authorization": f"Token {self.api_key}"}

        try:
            self._ws = await websockets.connect(
                url,
                extra_headers=headers,  # websockets 13.x kwarg name
                max_size=2**20,         # 1 MB message ceiling — Flux events are small
                ping_interval=20,
                ping_timeout=20,
            )
        except Exception as e:
            log.error("deepgram /v2/listen connect failed: %s", e)
            return False

        self._started = True
        log.info("deepgram /v2 connected (model=%s)", DEEPGRAM_MODEL)
        self._reader_task = asyncio.create_task(self._reader())
        self._writer_task = asyncio.create_task(self._writer())

        # Send Configure with language hints so Flux can code-switch on
        # multilingual speech. Sent via the writer queue's text path.
        try:
            await self._ws.send(json.dumps({
                "type": "Configure",
                "language_hints": list(DEFAULT_LANGUAGE_HINTS),
            }))
        except Exception as e:
            log.warning("deepgram Configure send failed: %s", e)

        return True

    def send(self, audio_bytes: bytes) -> None:
        """Sync handoff into the writer task's queue. Drops on overflow.

        Kept synchronous so the audio_ws receive loop doesn't need to await
        on every PCM frame.
        """
        if not self._started:
            return
        try:
            self._tx_queue.put_nowait(audio_bytes)
        except asyncio.QueueFull:
            self._dropped_frames += 1
            if self._dropped_frames % 100 == 1:
                log.warning(
                    "deepgram audio queue full — dropped %d frames",
                    self._dropped_frames,
                )

    async def stop(self) -> None:
        self._started = False
        for task in (self._reader_task, self._writer_task):
            if task is not None:
                task.cancel()
        if self._ws is not None:
            try:
                # Per Deepgram conventions, send the JSON close frame so the
                # server flushes any buffered transcript before closing.
                await self._ws.send(json.dumps({"type": "CloseStream"}))
            except Exception:
                pass
            try:
                await self._ws.close()
            except Exception:
                pass
        self._ws = None
        log.info("deepgram /v2 closed (dropped %d frames)", self._dropped_frames)

    # ------------------------------------------------------------------ tasks

    async def _writer(self) -> None:
        assert self._ws is not None
        try:
            while True:
                frame = await self._tx_queue.get()
                await self._ws.send(frame)
        except (asyncio.CancelledError, ConnectionClosed):
            return
        except Exception:
            log.exception("deepgram writer crashed")

    async def _reader(self) -> None:
        assert self._ws is not None
        try:
            async for msg in self._ws:
                if isinstance(msg, bytes):
                    continue   # Deepgram only sends text frames
                self._dispatch(msg)
        except (asyncio.CancelledError, ConnectionClosed):
            return
        except Exception:
            log.exception("deepgram reader crashed")

    # ------------------------------------------------------------------ parse

    def _dispatch(self, raw: str) -> None:
        # Log the first few raw events so we can confirm Flux's exact event
        # shape against the docs (which we can't verify pre-connect).
        if self._first_messages_logged < 3:
            log.info("deepgram raw event: %s", raw[:400])
            self._first_messages_logged += 1
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("deepgram non-JSON message: %r", raw[:120])
            return

        # Flux v2 documents transcript events under several variants depending
        # on the model; we extract defensively. Common shapes:
        #   { "type": "Results", "channel": { "alternatives": [...] }, ... }
        #   { "type": "Transcript", "transcript": "...", "is_final": ... }
        text, lang, is_final = _extract_transcript(payload)
        if text is None:
            return

        transcript = Transcript(text=text, language=lang or "en", is_final=bool(is_final))
        log.info(
            "transcript [%s] final=%s: %s",
            transcript.language, transcript.is_final, transcript.text,
        )
        if self._on_transcript:
            try:
                self._on_transcript(transcript)
            except Exception:
                log.exception("on_transcript callback raised")


def _extract_transcript(payload: dict[str, Any]) -> tuple[str | None, str | None, bool]:
    """Best-effort transcript extraction from a Flux event.

    Returns (text, language, is_final). text is None for non-transcript events.
    """
    # Shape 1 — same as nova v1: payload.channel.alternatives[0].transcript
    channel = payload.get("channel")
    if isinstance(channel, dict):
        alts = channel.get("alternatives")
        if isinstance(alts, list) and alts:
            alt = alts[0] or {}
            text = alt.get("transcript") or alt.get("text") or ""
            if text:
                lang = (
                    channel.get("detected_language")
                    or alt.get("language")
                    or payload.get("language")
                )
                is_final = bool(payload.get("is_final"))
                return text, lang, is_final

    # Shape 2 — Flux flat: payload.transcript / payload.text
    text = payload.get("transcript") or payload.get("text")
    if isinstance(text, str) and text:
        return text, payload.get("language"), bool(payload.get("is_final"))

    return None, None, False
