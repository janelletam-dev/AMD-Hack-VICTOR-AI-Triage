"""WebSocket endpoints for audio streaming and clinician event subscription.

/ws/audio   — Patient-side: receives PCM16 frames, forwards to Deepgram,
              publishes transcript events to the room's EventBus.
/ws/events  — Clinician-side: subscribes to a room's EventBus and relays
              all events (transcript, biomarker, concordance, etc.) as JSON.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Literal

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from config import settings
from services.deepgram_service import DeepgramService, Transcript
from services.event_bus import bus

log = logging.getLogger("victor.audio_ws")

router = APIRouter()

VoiceName = Literal["victor", "jackie"]


@router.websocket("/ws/audio")
async def audio_ws(
    ws: WebSocket,
    room: str = Query(..., min_length=1, max_length=64),
    voice: VoiceName = Query("victor"),
) -> None:
    """Patient-side audio WebSocket.

    Client streams binary PCM16 mono frames at 16 kHz. Server streams JSON
    text events back (transcript, biomarker, concordance_flag, soap_update,
    tts_audio, agent_activity, esi_update — see PRD §12.2).
    """
    await ws.accept()
    session_id = uuid.uuid4().hex[:8]
    started = time.time()
    log.info("ws open room=%s voice=%s session=%s", room, voice, session_id)

    await ws.send_text(
        json.dumps(
            {
                "type": "session",
                "data": {
                    "session_id": session_id,
                    "room": room,
                    "voice": voice,
                    "sample_rate": settings.sample_rate_hz,
                    "frame_bytes": settings.frame_bytes,
                },
            }
        )
    )

    event_queue = bus.subscribe(room)
    loop = asyncio.get_running_loop()

    async def on_transcript(t: Transcript) -> None:
        event = {
            "type": "transcript",
            "data": {
                "text": t.text,
                "language": t.language,
                "is_final": t.is_final,
            },
        }
        await bus.publish(room, event)

    def on_transcript_sync(t: Transcript) -> None:
        # Deepgram dispatches from a worker thread; bridge into the asyncio loop.
        asyncio.run_coroutine_threadsafe(on_transcript(t), loop)

    dg = DeepgramService(on_transcript=on_transcript_sync)
    dg_started = await dg.start()
    if dg_started:
        log.info("deepgram started for room=%s", room)
    else:
        log.warning("deepgram not available — will echo stub transcripts for room=%s", room)

    frames_received = 0
    bytes_received = 0
    heartbeat_task = asyncio.create_task(_heartbeat(ws, session_id))
    relay_task = asyncio.create_task(_relay_events(ws, event_queue))

    try:
        while True:
            msg = await ws.receive()

            if msg.get("type") == "websocket.disconnect":
                break

            if (data := msg.get("bytes")) is not None:
                frames_received += 1
                bytes_received += len(data)

                if len(data) != settings.frame_bytes and frames_received < 5:
                    log.warning(
                        "unexpected frame size: got %d bytes, expected %d",
                        len(data),
                        settings.frame_bytes,
                    )

                if dg_started:
                    dg.send(data)
                elif frames_received % 25 == 0:
                    await bus.publish(
                        room,
                        {
                            "type": "transcript",
                            "data": {
                                "text": f"[stub] {frames_received} frames received",
                                "language": "en",
                                "is_final": False,
                            },
                        },
                    )
                continue

            if (text := msg.get("text")) is not None:
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    log.warning("non-JSON text from client: %r", text[:120])
                    continue
                ptype = payload.get("type")
                log.info("client control: %s", ptype)
                # Forward identity / phase events to subscribers (clinician + EMR).
                if ptype in ("identity_update", "phase"):
                    await bus.publish(room, payload)

    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("ws error room=%s session=%s", room, session_id)
    finally:
        heartbeat_task.cancel()
        relay_task.cancel()
        bus.unsubscribe(room, event_queue)
        await dg.stop()
        elapsed = time.time() - started
        log.info(
            "ws close room=%s session=%s frames=%d bytes=%d elapsed=%.1fs",
            room,
            session_id,
            frames_received,
            bytes_received,
            elapsed,
        )


@router.websocket("/ws/events")
async def events_ws(
    ws: WebSocket,
    room: str = Query(..., min_length=1, max_length=64),
) -> None:
    """Clinician-side event subscriber.

    Subscribes to a room's EventBus and relays all events as JSON text frames.
    No audio sent on this socket — read-only event stream.
    """
    await ws.accept()
    log.info("clinician ws open room=%s", room)

    event_queue = bus.subscribe(room)
    heartbeat_task = asyncio.create_task(_heartbeat(ws, f"clinician-{room}"))

    try:
        while True:
            event = await event_queue.get()
            await ws.send_text(json.dumps(event))
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("clinician ws error room=%s", room)
    finally:
        heartbeat_task.cancel()
        bus.unsubscribe(room, event_queue)
        log.info("clinician ws closed room=%s", room)


async def _relay_events(ws: WebSocket, queue: asyncio.Queue) -> None:
    """Relay EventBus events back to the patient WebSocket."""
    try:
        while True:
            event = await queue.get()
            await ws.send_text(json.dumps(event))
    except (asyncio.CancelledError, WebSocketDisconnect):
        return
    except Exception:
        log.debug("relay ended", exc_info=True)


async def _heartbeat(ws: WebSocket, session_id: str) -> None:
    """Send a ping every 15s so proxies don't idle the socket out."""
    try:
        while True:
            await asyncio.sleep(15)
            await ws.send_text(
                json.dumps({"type": "heartbeat", "data": {"session_id": session_id}})
            )
    except (asyncio.CancelledError, WebSocketDisconnect):
        return
    except Exception:
        log.debug("heartbeat ended", exc_info=True)
