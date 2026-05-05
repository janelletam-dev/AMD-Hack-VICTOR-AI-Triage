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

from agents import swarm
from config import settings
from engine.concordance import engine as concordance_engine
from engine.concordance import detect_emergency
from services.deepgram_service import DeepgramService, Transcript
from services.event_bus import bus
from services.thymia_service import (
    HeliosResult,
    ThymiaService,
    dob_to_iso,
    pcm16_to_wav,
)

# Cap the per-session complaint-phase audio buffer at ~60s. At 1280 bytes/frame
# (40ms PCM16 @16 kHz mono) that's ~1500 frames ≈ 1.9 MB — well within Helios
# limits and keeps memory bounded if a patient lingers.
MAX_COMPLAINT_FRAMES = 1500

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

    # Hoisted forward-decl so DeepgramService can be constructed with the
    # threadsafe bridge below; the real on_transcript captures session state
    # (latest transcript + detected language for Helios).
    on_transcript_holder: dict[str, object] = {}

    def on_transcript_sync(t: Transcript) -> None:
        # Deepgram dispatches from a worker thread; bridge into the asyncio loop.
        fn = on_transcript_holder.get("fn")
        if fn:
            asyncio.run_coroutine_threadsafe(fn(t), loop)

    dg = DeepgramService(on_transcript=on_transcript_sync)
    dg_started = await dg.start()
    if dg_started:
        log.info("deepgram started for room=%s", room)
    else:
        log.warning("deepgram not available — will echo stub transcripts for room=%s", room)

    thymia = ThymiaService()

    # Per-session state we accumulate while the patient talks.
    state = {
        "phase": None,                      # current phase from client `phase` events
        "dob_iso": None,                    # captured DOB in ISO 8601
        "complaint_pcm": [],                # PCM16 frames during the complaint phase
        "latest_final_transcript": "",      # for concordance evaluation
        "helios_submitted": False,          # one Helios run per session
        "helios_lang": "en-US",             # default; updated from Deepgram language
        # J.A.C.K.I.E. follow-up loop state
        "jackie_turn_count": 0,             # how many J.A.C.K.I.E. turns have fired
        "jackie_max_turns": 6,              # OPQRST coverage typically fits in 6 turns
        "jackie_busy": False,               # debounce: don't double-fire on rapid finals
        "escalated": False,                 # flipped when V.I.C.T.O.R. emits a flag
        "jackie_history": [],               # list[ {"role","text"} ] for context if we want it
    }

    state["emergency_fired"] = False

    async def on_transcript(t: Transcript) -> None:
        # Track the most recent finalised transcript for concordance + remember
        # detected language for Helios.
        if t.is_final and t.text:
            state["latest_final_transcript"] = t.text
        if t.language and t.language != "multi":
            # Map "en" → "en-US" etc; thymia wants BCP-47-ish codes.
            state["helios_lang"] = (
                t.language if "-" in t.language else f"{t.language}-US"
            )
        await bus.publish(
            room,
            {
                "type": "transcript",
                "data": {
                    "text": t.text,
                    "language": t.language,
                    "is_final": t.is_final,
                },
            },
        )

        # Patient-safety short-circuit: any explicit emergency phrase
        # (e.g. "I can't breathe", "my chest is crushing") forces ESI-1
        # regardless of biomarkers, and aborts the J.A.C.K.I.E. loop.
        if t.is_final and t.text and not state["emergency_fired"]:
            em = detect_emergency(t.text)
            if em is not None:
                state["emergency_fired"] = True
                asyncio.create_task(handle_emergency(em, t.text, t.language or "en"))
                return  # don't run normal J.A.C.K.I.E. flow on this turn

        # During the J.A.C.K.I.E. follow-up loop, every finalised patient
        # utterance triggers the next turn.
        if (
            t.is_final
            and t.text
            and state["phase"] == "conversation"
            and not state["jackie_busy"]
            and not state["emergency_fired"]
            and state["jackie_turn_count"] < state["jackie_max_turns"]
        ):
            asyncio.create_task(jackie_turn(t.text, t.language or "en"))

    async def handle_emergency(em, utterance: str, language: str) -> None:
        """Patient said an explicit emergency phrase. Force ESI-1, emit a
        critical alert, and tell the patient (calmly) to stay put.
        """
        log.warning(
            "session=%s EMERGENCY detected: %s — phrase=%r",
            session_id, em.label, em.matched_phrase,
        )
        # 1. Critical event for the clinician dashboard.
        await bus.publish(
            room,
            {
                "type": "triage_emergency",
                "data": {
                    "label": em.label,
                    "severity": em.severity,
                    "matched_phrase": em.matched_phrase,
                    "trigger_utterance": utterance,
                    "language": language,
                    "agent": "V.I.C.T.O.R.",
                },
            },
        )
        # 2. Force ESI 1 — bypasses the normal concordance pipeline.
        await bus.publish(
            room,
            {
                "type": "esi_update",
                "data": {
                    "standard_esi": 3,
                    "victor_esi": 1,
                    "adjustment_reason": (
                        f"Verbal emergency signal ({em.label}): patient "
                        f"said {em.matched_phrase!r}."
                    ),
                    "agent": "V.I.C.T.O.R.",
                },
            },
        )
        # 3. Calm closing turn for the patient. Skip remaining J.A.C.K.I.E.
        closing = (
            "I hear you. Stay right here — I'm getting someone to you immediately."
        )
        await bus.publish(
            room,
            {
                "type": "jackie_turn",
                "data": {
                    "text": closing,
                    "turn": state["jackie_turn_count"] + 1,
                    "max_turns": state["jackie_max_turns"],
                    "language": language,
                    "closing": True,
                    "emergency": True,
                },
            },
        )
        # 4. Signal triage complete so the kiosk advances to Done.
        await bus.publish(
            room,
            {"type": "triage_complete", "data": {"reason": f"emergency:{em.label}"}},
        )

    on_transcript_holder["fn"] = on_transcript

    async def jackie_turn(patient_utterance: str, language: str) -> None:
        """Run one J.A.C.K.I.E. turn: ask agent for next question, publish
        `jackie_turn` event, and emit `triage_complete` once we hit max turns.
        """
        state["jackie_busy"] = True
        try:
            state["jackie_turn_count"] += 1
            turn = state["jackie_turn_count"]
            await bus.publish(
                room,
                {
                    "type": "agent_activity",
                    "data": {
                        "agent": "J.A.C.K.I.E.",
                        "status": "active",
                        "action": f"Composing follow-up #{turn}",
                    },
                },
            )
            text = await swarm.jackie.respond(
                patient_utterance,
                language=language,
                escalated=state["escalated"],
            )
            state["jackie_history"].append({"role": "patient", "text": patient_utterance})
            state["jackie_history"].append({"role": "jackie", "text": text})
            await bus.publish(
                room,
                {
                    "type": "jackie_turn",
                    "data": {
                        "text": text,
                        "turn": turn,
                        "max_turns": state["jackie_max_turns"],
                        "language": language,
                    },
                },
            )
            await bus.publish(
                room,
                {
                    "type": "agent_activity",
                    "data": {"agent": "J.A.C.K.I.E.", "status": "idle", "action": "Awaiting reply"},
                },
            )
            if turn >= state["jackie_max_turns"]:
                # Send a warm closing turn, then signal completion.
                closing = (
                    "Thank you for sharing all of that. A clinician will be "
                    "with you very soon, and everything you've told me will be "
                    "right in front of them."
                )
                await bus.publish(
                    room,
                    {
                        "type": "jackie_turn",
                        "data": {
                            "text": closing,
                            "turn": turn + 1,
                            "max_turns": state["jackie_max_turns"],
                            "language": language,
                            "closing": True,
                        },
                    },
                )
                await bus.publish(
                    room,
                    {
                        "type": "triage_complete",
                        "data": {"reason": "interview-coverage-complete"},
                    },
                )
        finally:
            state["jackie_busy"] = False

    frames_received = 0
    bytes_received = 0
    heartbeat_task = asyncio.create_task(_heartbeat(ws, session_id))
    relay_task = asyncio.create_task(_relay_events(ws, event_queue))
    helios_tasks: list[asyncio.Task] = []

    async def submit_helios_and_evaluate() -> None:
        """Encode buffered complaint-phase audio, submit to Helios, publish
        the biomarker event, then run the concordance engine and publish any
        flags. Runs as a background task so it doesn't block audio receive.
        """
        if state["helios_submitted"]:
            return
        state["helios_submitted"] = True

        pcm_chunks: list[bytes] = list(state["complaint_pcm"])
        if not pcm_chunks:
            log.info("session=%s no complaint audio — skipping helios", session_id)
            return

        wav_bytes = pcm16_to_wav(b"".join(pcm_chunks), settings.sample_rate_hz)
        # Helios needs ≥10s of speech; 250 PCM frames = 10s at 40ms/frame.
        if len(pcm_chunks) < 250:
            log.info(
                "session=%s only %d frames (~%.1fs) buffered — below Helios min, skipping",
                session_id, len(pcm_chunks), len(pcm_chunks) * 0.04,
            )
            return

        if not thymia.enabled:
            log.info("session=%s thymia disabled — no biomarker event", session_id)
            return

        log.info(
            "session=%s submitting %d frames (~%.1fs) to helios",
            session_id, len(pcm_chunks), len(pcm_chunks) * 0.04,
        )
        result: HeliosResult | None = await thymia.submit_helios(
            wav_bytes,
            user_label=session_id,
            date_of_birth=state["dob_iso"],
            language=state["helios_lang"],
        )
        if not result:
            return

        await bus.publish(room, {"type": "biomarker", "data": result.to_event()})

        # Run the concordance engine, then hand off to V.I.C.T.O.R. The
        # orchestrator publishes concordance_flag (with M.E.R.C.E.D. gloss),
        # esi_update, and soap_update events — and emits agent_activity for
        # the swarm panel along the way.
        helios_block = result.to_event()["helios"]
        flags = concordance_engine.evaluate(
            state["latest_final_transcript"], {"helios": helios_block}
        )
        # If any concordance flag fires, mark the session as escalated so
        # subsequent J.A.C.K.I.E. turns use ESCALATED MODE (targeted cardiac
        # elicitation, framed as routine intake).
        if flags:
            state["escalated"] = True
        await swarm.victor.on_concordance_evaluation(
            room=room,
            flags=flags,
            transcript=state["latest_final_transcript"],
            biomarkers={"helios": helios_block},
            chief_complaint_label=(flags[0].triage_label if flags else None),
        )

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

                # Buffer audio while the patient is on the chief-complaint
                # phase — that's the speech we'll send to Helios.
                if state["phase"] == "complaint":
                    if len(state["complaint_pcm"]) < MAX_COMPLAINT_FRAMES:
                        state["complaint_pcm"].append(data)
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

                # Track phase locally so we know when to start/stop buffering
                # complaint audio and when to fire Helios + the J.A.C.K.I.E. loop.
                if ptype == "phase":
                    new_phase = (payload.get("data") or {}).get("phase")
                    prev_phase = state["phase"]
                    state["phase"] = new_phase
                    if prev_phase == "complaint" and new_phase != "complaint":
                        helios_tasks.append(
                            asyncio.create_task(submit_helios_and_evaluate())
                        )
                    # Entering the conversation phase → kick off J.A.C.K.I.E.
                    # against the captured chief complaint.
                    if new_phase == "conversation" and state["jackie_turn_count"] == 0:
                        seed = state["latest_final_transcript"] or "the patient's chief complaint"
                        helios_tasks.append(asyncio.create_task(
                            jackie_turn(seed, language=state["helios_lang"].split("-")[0])
                        ))

                # Capture the confirmed DOB from identity_update so Helios
                # can include it on the model run.
                if ptype == "identity_update":
                    dob = (payload.get("data") or {}).get("dob")
                    if dob:
                        iso = dob_to_iso(dob)
                        if iso:
                            state["dob_iso"] = iso

    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("ws error room=%s session=%s", room, session_id)
    finally:
        heartbeat_task.cancel()
        relay_task.cancel()
        # If the session ended while still on the complaint phase (abrupt close),
        # fire Helios on whatever we buffered.
        if state["phase"] == "complaint" and not state["helios_submitted"]:
            helios_tasks.append(asyncio.create_task(submit_helios_and_evaluate()))
        # Detach the bus before any pending Helios task tries to publish — they
        # publish via `bus`, which fans out to whoever's still subscribed (the
        # clinician dashboard remains subscribed even after this patient socket closes).
        bus.unsubscribe(room, event_queue)
        await dg.stop()
        # Don't await helios_tasks here — they keep running in the background
        # and publish to the room once Helios returns.
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
