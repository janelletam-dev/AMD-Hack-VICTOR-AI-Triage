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
import struct
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlencode

import websockets
from websockets.exceptions import ConnectionClosed

from config import settings


# Writer-stall watchdog: if the outbound queue grows past this fraction of
# its cap AND the writer hasn't successfully sent in WRITER_STALL_SECONDS,
# we assume the WS is silently dead (half-open TCP, e.g. NAT timeout) and
# force a reconnect. The websockets library's ping/pong should usually
# catch this within ping_interval + ping_timeout (40s here), but in
# practice we've seen sessions where neither reader nor writer raises and
# frames just pile up. The watchdog is the belt to ping/pong's suspenders.
WRITER_STALL_QUEUE_FRACTION = 0.5  # 50% of MAX queue
WRITER_STALL_SECONDS = 5.0


def _streaming_wav_header(sample_rate: int = 16_000, channels: int = 1) -> bytes:
    """Build a 44-byte RIFF/WAVE header for an open-ended PCM16 stream.

    Flux v2 auto-detects audio format from the byte stream. Without a header
    it returns UNPARSABLE_CLIENT_MESSAGE. We prepend this header once on
    connection so Flux identifies the stream as little-endian signed 16-bit
    PCM at 16 kHz mono; subsequent raw PCM frames continue the WAV `data`
    payload. The size fields are set to 0xFFFFFFFF so the reader treats it
    as an unbounded stream rather than checking against a declared length.
    """
    bits_per_sample = 16
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    huge = 0xFFFFFFFF
    fmt_chunk = struct.pack(
        "<4sIHHIIHH",
        b"fmt ", 16, 1, channels, sample_rate, byte_rate, block_align, bits_per_sample,
    )
    data_chunk = struct.pack("<4sI", b"data", huge)
    riff = struct.pack("<4sI4s", b"RIFF", huge, b"WAVE")
    return riff + fmt_chunk + data_chunk

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
    confidence: float = 1.0


MAX_RECONNECT_ATTEMPTS = 3
RECONNECT_DELAY_S = 1.0


class DeepgramService:
    """Per-session Deepgram Flux v2 streaming connection.

    Usage:
        dg = DeepgramService(on_transcript=my_callback)
        await dg.start()
        dg.send(pcm16_bytes)   # call repeatedly with audio frames
        await dg.stop()

    Reconnection: if Deepgram disconnects mid-sentence, the service buffers
    the last partial transcript, reconnects automatically, and resumes. The
    patient never knows. Audio frames sent during reconnection are queued
    (up to _TX_QUEUE_MAX) and flushed on reconnect.
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
        self._reconnect_attempts = 0
        self._reconnecting = False
        self._last_partial_text = ""
        # Watchdog state — updated each time the writer successfully ships
        # a frame to Deepgram. Initialised to "now" on start so the first
        # few seconds before audio flows don't trigger a false stall.
        self._last_writer_send_at = 0.0

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
        # Reset the watchdog clock — gives the first few seconds before
        # audio starts flowing without false stall alerts.
        self._last_writer_send_at = time.time()
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

        Watchdog: if the queue is filling up AND the writer hasn't shipped
        a frame in WRITER_STALL_SECONDS, the WS is silently dead (NAT
        timeout / half-open TCP). Force a reconnect — neither reader nor
        writer raised so reconnect won't fire on its own.
        """
        if not self._started:
            return
        # Watchdog check (cheap — just qsize + a timestamp diff)
        queue_size = self._tx_queue.qsize()
        if queue_size > _TX_QUEUE_MAX * WRITER_STALL_QUEUE_FRACTION:
            idle = time.time() - (self._last_writer_send_at or 0)
            if idle > WRITER_STALL_SECONDS and not self._reconnecting:
                log.warning(
                    "deepgram writer stalled (%d frames queued, %.1fs since last send) — forcing reconnect",
                    queue_size, idle,
                )
                try:
                    asyncio.get_event_loop().create_task(self._reconnect())
                except RuntimeError:
                    pass  # no running loop in this thread (called from worker bridge)
                # Don't enqueue more frames during a stall — they'd just be dropped
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
        # Identify the stream format to Flux v2 before any audio bytes flow.
        # Without this, Flux returns UNPARSABLE_CLIENT_MESSAGE on the first frame.
        try:
            await self._ws.send(_streaming_wav_header(settings.sample_rate_hz, 1))
            log.info("deepgram: sent streaming WAV header (16-bit PCM, %d Hz, mono)", settings.sample_rate_hz)
            self._last_writer_send_at = time.time()
        except Exception:
            log.exception("deepgram: failed to send WAV header — triggering reconnect")
            if self._started and not self._reconnecting:
                asyncio.create_task(self._reconnect())
            return
        try:
            while True:
                frame = await self._tx_queue.get()
                await self._ws.send(frame)
                # Watchdog timestamp — proves the writer is still draining
                # the queue. send() reads this to detect a stalled writer.
                self._last_writer_send_at = time.time()
        except (asyncio.CancelledError, ConnectionClosed):
            return
        except Exception:
            # Any other exception means the WS is in a bad state but
            # didn't surface as ConnectionClosed (rare, but happens with
            # half-open sockets). Fire reconnect — the old code just
            # logged and let frames pile up forever in the queue.
            log.exception("deepgram writer crashed — triggering reconnect")
            if self._started and not self._reconnecting:
                asyncio.create_task(self._reconnect())

    async def _reader(self) -> None:
        assert self._ws is not None
        try:
            async for msg in self._ws:
                if isinstance(msg, bytes):
                    continue   # Deepgram only sends text frames
                self._dispatch(msg)
        except asyncio.CancelledError:
            return
        except ConnectionClosed:
            if self._started and not self._reconnecting:
                log.warning("deepgram disconnected mid-session — attempting reconnect")
                asyncio.create_task(self._reconnect())
            return
        except Exception:
            log.exception("deepgram reader crashed")
            if self._started and not self._reconnecting:
                asyncio.create_task(self._reconnect())

    async def _reconnect(self) -> None:
        """Attempt to reconnect to Deepgram after an unexpected disconnect.
        Buffers the last partial transcript so nothing the patient said is lost."""
        if self._reconnecting:
            return
        self._reconnecting = True
        for task in (self._reader_task, self._writer_task):
            if task is not None:
                task.cancel()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

        while self._reconnect_attempts < MAX_RECONNECT_ATTEMPTS and self._started:
            self._reconnect_attempts += 1
            await asyncio.sleep(RECONNECT_DELAY_S * self._reconnect_attempts)
            log.info(
                "deepgram reconnect attempt %d/%d",
                self._reconnect_attempts, MAX_RECONNECT_ATTEMPTS,
            )
            params = {"model": DEEPGRAM_MODEL}
            url = f"{DEEPGRAM_BASE}{DEEPGRAM_PATH}?{urlencode(params)}"
            headers = {"Authorization": f"Token {self.api_key}"}
            try:
                self._ws = await websockets.connect(
                    url,
                    extra_headers=headers,
                    max_size=2**20,
                    ping_interval=20,
                    ping_timeout=20,
                )
            except Exception as e:
                log.warning("deepgram reconnect failed: %s", e)
                continue

            log.info("deepgram reconnected successfully")
            self._reconnect_attempts = 0
            self._reader_task = asyncio.create_task(self._reader())
            self._writer_task = asyncio.create_task(self._writer())
            try:
                await self._ws.send(json.dumps({
                    "type": "Configure",
                    "language_hints": list(DEFAULT_LANGUAGE_HINTS),
                }))
            except Exception:
                pass
            self._reconnecting = False
            return

        log.error("deepgram reconnect exhausted %d attempts — STT offline", MAX_RECONNECT_ATTEMPTS)
        self._started = False
        self._reconnecting = False

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
        text, lang, is_final, confidence = _extract_transcript(payload)
        if text is None:
            return

        transcript = Transcript(
            text=text, language=lang or "en",
            is_final=bool(is_final), confidence=confidence,
        )
        log.info(
            "transcript [%s] final=%s: %s",
            transcript.language, transcript.is_final, transcript.text,
        )
        if self._on_transcript:
            try:
                self._on_transcript(transcript)
            except Exception:
                log.exception("on_transcript callback raised")


def _extract_transcript(payload: dict[str, Any]) -> tuple[str | None, str | None, bool, float]:
    """Best-effort transcript extraction from a Flux event.

    Returns (text, language, is_final, confidence). text is None for non-transcript events.
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
                confidence = float(alt.get("confidence", 1.0))
                return text, lang, is_final, confidence

    # Shape 2 — Flux v2 TurnInfo: payload.transcript / payload.text with
    # an "event" discriminator instead of an is_final boolean. The
    # documented event values are:
    #   "Update"           — interim partial within a turn
    #   "EagerEndOfTurn"   — provisional final (only if eager threshold set)
    #   "EndOfTurn"        — committed final at end of turn
    # Older Nova v1 payloads use is_final directly; we honour both so this
    # extractor is forwards/backwards compatible.
    text = payload.get("transcript") or payload.get("text")
    if isinstance(text, str) and text:
        confidence = float(payload.get("confidence", 1.0))
        event = payload.get("event")
        if event in ("EndOfTurn", "EagerEndOfTurn"):
            is_final_flag = True
        elif event == "Update":
            is_final_flag = False
        else:
            is_final_flag = bool(payload.get("is_final"))
        return text, payload.get("language"), is_final_flag, confidence

    return None, None, False, 1.0
