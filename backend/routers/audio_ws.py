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
from engine.concordance import detect_emergency, detect_safety_escalation
from services.clinical_knowledge import (
    compute_clinical_alvarado,
    compute_clinical_heart,
    compute_clinical_wells,
    is_abdominal_pain,
    is_chest_pain,
    is_dyspnea_or_pe_concern,
)
from services.coverage_tracker import (
    extract_covered, extract_negatives, priority_order, replace_if_redundant,
    extract_disclosed_facts, render_facts_block,
)
from services.deepgram_service import DeepgramService, Transcript
from services.event_bus import bus
from services.thymia_service import (
    ApolloResult,
    HeliosResult,
    PsycheResult,
    ThymiaService,
    dob_to_iso,
    pcm16_to_wav,
)

# Cap the per-session voice buffer at ~120s. At 1280 bytes/frame (40ms PCM16
# @16 kHz mono) that's 3000 frames ≈ 3.8 MB. Bumped from 60s when we extended
# Helios to capture both complaint AND conversation-phase audio for incremental
# refinement of biomarker scores.
MAX_COMPLAINT_FRAMES = 3000

# Re-run Helios every N completed JACKIE turns to refine biomarker scores
# as more speech accumulates. The first run still fires at the end of the
# complaint phase (fast concordance flag); subsequent runs publish updated
# `biomarker` events that supersede the previous values on the dashboard.
HELIOS_REFRESH_EVERY_N_TURNS = 2

log = logging.getLogger("victor.audio_ws")


async def _publish_risk_scores(
    bus_,
    room: str,
    state: dict,
    transcript: str,
    age: int | None,
) -> None:
    """Run every applicable risk score against the patient's
    accumulated transcript and publish a `risk_score` event for each
    one whose chief-complaint gate fires. Currently:
      - HEART (cardiac CCs)         — clinical_knowledge.is_chest_pain
      - Wells/PE (SOB or pleuritic) — is_dyspnea_or_pe_concern
      - Alvarado (abdominal CCs)    — is_abdominal_pain
    Each score is recomputed on every JACKIE turn as more PMH and
    classical features surface — the dashboard's RiskScoreBadge
    re-renders with the latest values per `score` key.
    """
    cc = state.get("complaint_text") or transcript
    # HEART
    if is_chest_pain(cc):
        heart = compute_clinical_heart(transcript, age)
        state["heart_score"] = heart
        await bus_.publish(room, {
            "type": "risk_score",
            "data": {"score": "HEART", **heart},
        })
    # Wells / PE
    if is_dyspnea_or_pe_concern(cc):
        wells = compute_clinical_wells(transcript)
        state["wells_score"] = wells
        await bus_.publish(room, {
            "type": "risk_score",
            "data": wells,
        })
    # Alvarado / appendicitis (broadly: abdominal pain)
    if is_abdominal_pain(cc):
        alvarado = compute_clinical_alvarado(transcript)
        state["alvarado_score"] = alvarado
        await bus_.publish(room, {
            "type": "risk_score",
            "data": alvarado,
        })


def _full_patient_text(state: dict) -> str:
    """Concatenate everything the patient has said so far — the chief
    complaint plus every patient turn from JACKIE history. Used as
    input to demo-mode Helios so the scripted biomarkers respond to
    keywords ("exhausted" → exhaustion bumps). For real Thymia API
    this argument is harmlessly ignored (audio is the input there)."""
    parts: list[str] = []
    if state.get("complaint_text"):
        parts.append(state["complaint_text"])
    for h in state.get("jackie_history") or []:
        if h.get("role") == "patient" and h.get("text"):
            parts.append(h["text"])
    if state.get("latest_final_transcript"):
        parts.append(state["latest_final_transcript"])
    return " ".join(parts)


def _age_from_dob_iso(dob_iso: str | None) -> int | None:
    """Return integer age (years) from an ISO 8601 DOB string, or None
    if dob is missing/malformed. Used to feed SCRIBE the patient's age
    so the HPI paragraph opens correctly ("47-year-old female presenting
    with…") instead of generic "patient presenting with…".
    """
    if not dob_iso or not isinstance(dob_iso, str):
        return None
    try:
        from datetime import date
        y, m, d = (int(p) for p in dob_iso.split("-")[:3])
        today = date.today()
        age = today.year - y - (
            (today.month, today.day) < (m, d)
        )
        return age if 0 <= age < 150 else None
    except (ValueError, TypeError):
        return None


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
        "complaint_text": "",               # full chief complaint from identity_update — used as J.A.C.K.I.E.'s seed so the follow-up isn't asking the same opening question the patient just answered
        "gender": None,                     # captured from identity_update; used to bias coverage priority (LMP for female + abdominal pain, etc.)
        "pertinent_negatives": [],          # explicit denials from the patient ("no SOB", "denies radiation"); woven into the SCRIBE HPI paragraph for chart completeness — pertinent negatives rule out can't-miss diagnoses
        "heart_score": None,                # clinical (pre-EKG, pre-troponin) HEART score for chest-pain cases; recomputed each turn as PMH and classical features surface
        "wells_score": None,                # clinical (pre-vital, pre-imaging) Wells PE score for SOB / pleuritic chest cases
        "alvarado_score": None,             # clinical (pre-exam, pre-lab) Alvarado score for abdominal-pain cases — limited at triage but useful as anchor
        "helios_submitted": False,          # one Helios run per session
        "helios_lang": "en-US",             # default; updated from Deepgram language
        # J.A.C.K.I.E. follow-up loop state
        "jackie_turn_count": 0,             # how many J.A.C.K.I.E. turns have fired
        "helios_submit_count": 0,           # 0 = never, 1 = initial, 2+ = refreshes
        "last_helios_submit_frames": 0,     # buffer length at last Helios submission
        "jackie_max_turns": 6,              # OPQRST coverage typically fits in 6 turns
        "jackie_busy": False,               # debounce: don't double-fire on rapid finals
        "escalated": False,                 # flipped when V.I.C.T.O.R. emits a flag
        "jackie_history": [],               # list[ {"role","text"} ] for context if we want it
    }

    state["emergency_fired"] = False
    state["safety_escalated"] = False
    state["last_audio_time"] = time.time()
    state["silence_warned"] = False
    state["session_abandoned"] = False

    async def check_silence() -> None:
        """Monitor for patient silence. After 60s of no audio, prompt.
        After 3 minutes total silence, mark session as abandoned."""
        while True:
            await asyncio.sleep(10)
            if state["session_abandoned"] or state["emergency_fired"]:
                return
            if state["phase"] not in ("complaint", "conversation"):
                continue
            elapsed = time.time() - state["last_audio_time"]
            if elapsed >= 180 and not state["session_abandoned"]:
                state["session_abandoned"] = True
                await bus.publish(room, {
                    "type": "session_status",
                    "data": {
                        "status": "abandoned",
                        "reason": "Patient silence exceeded 3 minutes",
                        "session_id": session_id,
                    },
                })
                return
            if elapsed >= 60 and not state["silence_warned"]:
                state["silence_warned"] = True
                silence_prompt = (
                    "It seems like you've stepped away. "
                    "I'll be here when you're ready."
                )
                await bus.publish(room, {
                    "type": "jackie_turn",
                    "data": {
                        "text": silence_prompt,
                        "turn": state["jackie_turn_count"],
                        "max_turns": state["jackie_max_turns"],
                        "language": state["helios_lang"].split("-")[0],
                        "silence_prompt": True,
                    },
                })

    # Confidence threshold below which we ask the patient to repeat.
    LOW_CONFIDENCE_THRESHOLD = 0.5

    async def on_transcript(t: Transcript) -> None:
        # Low confidence from Deepgram (noisy ER environment) → ask patient to repeat.
        if (
            t.is_final
            and t.text
            and t.confidence < LOW_CONFIDENCE_THRESHOLD
            and state["phase"] in ("complaint", "conversation")
            and not state["emergency_fired"]
        ):
            await bus.publish(room, {
                "type": "jackie_turn",
                "data": {
                    "text": "I didn't quite catch that. Could you say that again?",
                    "turn": state["jackie_turn_count"],
                    "max_turns": state["jackie_max_turns"],
                    "language": state["helios_lang"].split("-")[0],
                    "low_confidence": True,
                },
            })
            return

        # Track the most recent finalised transcript for concordance + remember
        # detected language for Helios.
        if t.is_final and t.text:
            state["latest_final_transcript"] = t.text
        if t.language and t.language != "multi":
            # Map "en" → "en-US" etc; thymia wants BCP-47-ish codes.
            state["helios_lang"] = (
                t.language if "-" in t.language else f"{t.language}-US"
            )

        # Unsupported language detection: if Deepgram detects a language we
        # don't support, tell the patient which languages work.
        SUPPORTED_LANGUAGES = {"en", "es", "fr", "de", "pt", "hi", "it", "th"}
        if (
            t.is_final
            and t.language
            and t.language not in SUPPORTED_LANGUAGES
            and t.language != "multi"
            and not state.get("unsupported_lang_warned")
        ):
            state["unsupported_lang_warned"] = True
            lang_msg = (
                "I want to make sure I understand you correctly. "
                "We currently support English, Spanish, French, German, "
                "Portuguese, Hindi, Italian, and Thai. "
                "Would any of those work for you?"
            )
            await bus.publish(room, {
                "type": "jackie_turn",
                "data": {
                    "text": lang_msg,
                    "turn": state["jackie_turn_count"],
                    "max_turns": state["jackie_max_turns"],
                    "language": "en",
                    "unsupported_language": True,
                    "detected_language": t.language,
                },
            })

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

        # ESI-2 safety net: hardcoded keyword check BEFORE the LLM.
        # "chest pain", "can't breathe", "heart attack", etc. auto-escalate
        # to ESI-2 regardless of what the LLM thinks. Never rely solely on
        # AI for life-threatening keywords.
        if t.is_final and t.text and not state["emergency_fired"] and not state.get("safety_escalated"):
            safety = detect_safety_escalation(t.text)
            if safety is not None:
                state["safety_escalated"] = True
                asyncio.create_task(handle_safety_escalation(safety, t.text, t.language or "en"))

        # During the conversation phase the kiosk now uses an editable
        # textarea (same pattern as the complaint phase) — the patient
        # speaks, the transcript lands in the textarea, they edit any
        # mistranscriptions, then tap Send. The Send tap fires a
        # `conversation_answer` event (handled below) which is the
        # canonical commit signal. We DO NOT auto-trigger jackie_turn
        # on every finalised transcript anymore — that was the old
        # read-only TranscriptCard pattern and it bypassed the patient's
        # ability to correct STT errors before J.A.C.K.I.E. reasons
        # against them.

    async def handle_emergency(em, utterance: str, language: str) -> None:
        """Patient said an explicit emergency phrase. Force ESI-1, emit a
        critical alert, and tell the patient (calmly) to stay put.
        """
        # Log only the category label — never the exact phrase. Patient-spoken
        # health information is PHI and should not appear in plaintext logs.
        # The full transcript still flows to the clinician dashboard via the
        # event bus, where it's visible to authorised clinicians only.
        log.warning("session=%s EMERGENCY detected: %s", session_id, em.label)
        # 1. Critical event for the clinician dashboard — broadcast to ALL
        # rooms when ESI-1, not just the assigned nurse.
        emergency_payload = {
            "type": "triage_emergency",
            "data": {
                "label": em.label,
                "severity": em.severity,
                "matched_phrase": em.matched_phrase,
                "trigger_utterance": utterance,
                "language": language,
                "agent": "V.I.C.T.O.R.",
                "source_room": room,
                "session_id": session_id,
            },
        }
        if em.severity == "ESI-1":
            await bus.broadcast_all(emergency_payload)
        else:
            await bus.publish(room, emergency_payload)
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

    # Clinical-guideline citations per safety-keyword category. The
    # auto-escalation message surfaces the *basis* for the hardcoded
    # ESI-2 floor so a clinician auditor (or judge) can verify what the
    # rule is grounded in. Citations point at the canonical source —
    # ENA ESI Implementation Handbook 4e is the primary reference for
    # ED triage acuity rules in the US; specialty-society guidelines
    # (AHA, GOLD, etc.) cover the disease-specific rationale.
    SAFETY_CITATIONS: dict[str, str] = {
        "chest pain": (
            "ENA ESI 4e (high-risk situation rule: chest pain in adults ≥ ESI-2); "
            "2021 AHA/ACC Chest Pain Guideline §3.1 (≤10 min door-to-ECG)"
        ),
        "breathing difficulty": (
            "ENA ESI 4e (respiratory distress ≥ ESI-2); "
            "GOLD 2024 / AHA HF guidelines (acute dyspnea workup)"
        ),
        "cardiac concern": (
            "ENA ESI 4e (high-risk cardiac symptoms ≥ ESI-2); "
            "2021 AHA/ACC Chest Pain Guideline §3.1"
        ),
        "subjective dying": (
            "ENA ESI 4e (\"sense of impending doom\" → ESI-2 minimum); "
            "documented predictor of ACS, PE, dissection in ED literature"
        ),
    }

    async def handle_safety_escalation(safety, utterance: str, language: str) -> None:
        """Hardcoded ESI-2 safety escalation. Does NOT abort triage — the
        interview continues, but the clinician gets an immediate alert and
        ESI is forced to at most 2. This runs BEFORE the LLM has any say."""
        # Log only the category label — see PHI note above on handle_emergency.
        log.warning("session=%s SAFETY ESCALATION: %s", session_id, safety.label)
        state["escalated"] = True
        citation = SAFETY_CITATIONS.get(safety.label, "ENA ESI 4e (high-risk situation rule)")
        await bus.publish(room, {
            "type": "safety_escalation",
            "data": {
                "label": safety.label,
                "severity": safety.severity,
                "matched_phrase": safety.matched_phrase,
                "trigger_utterance": utterance,
                "language": language,
                "agent": "V.I.C.T.O.R.",
                "source_room": room,
                "session_id": session_id,
                "citation": citation,
                "note": (
                    f"Auto-escalated to ESI-2 by hardcoded keyword detection. "
                    f"Basis: {citation}. LLM assessment not required for this decision."
                ),
            },
        })
        await bus.publish(room, {
            "type": "esi_update",
            "data": {
                "standard_esi": 3,
                "victor_esi": 2,
                "adjustment_reason": (
                    f"Safety keyword ({safety.label}): patient said "
                    f"{safety.matched_phrase!r}. Auto-escalated to ESI-2. "
                    f"Basis: {citation}. Hardcoded clinical-guideline rule — "
                    f"no AI inference required."
                ),
                "citation": citation,
                "agent": "V.I.C.T.O.R.",
                "hardcoded": True,
            },
        })

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
            # Pass the conversation history (and chief complaint as the
            # seed turn) so J.A.C.K.I.E. has full context and doesn't
            # ask questions the patient already answered. Snapshot the
            # history list before passing — we mutate it after the
            # response, and we don't want a half-built turn in scope.
            #
            # Compute coverage from ALL patient utterances seen so far
            # (history + chief complaint + the just-spoken utterance).
            # Coverage tracker is a regex-based extractor — see
            # services/coverage_tracker.py. The result tells JACKIE
            # which OPQRST/SAMPLE elements have been answered and what
            # to ask next, biased by chief-complaint priority.
            history_snapshot = list(state["jackie_history"])
            coverage_input = list(history_snapshot)
            if state.get("complaint_text"):
                coverage_input.append({"role": "patient", "text": state["complaint_text"]})
            if patient_utterance:
                coverage_input.append({"role": "patient", "text": patient_utterance})
            covered = extract_covered(coverage_input)
            negatives = extract_negatives(coverage_input)
            # Recompute clinical risk scores against the full
            # accumulated transcript (chief complaint + every patient
            # turn so far). Scores tend to grow as PMH surfaces and
            # classical features emerge in follow-ups. Each score
            # gates on its own chief-complaint trigger so we don't
            # publish a low Wells for a chest-pain case (or vice versa).
            full_text = " ".join(
                h.get("text", "")
                for h in coverage_input
                if h.get("role") == "patient"
            )
            await _publish_risk_scores(
                bus, room, state, full_text,
                age=_age_from_dob_iso(state.get("dob_iso")),
            )
            remaining = priority_order(
                state.get("complaint_text"),
                state.get("gender"),
                covered,
            )
            # Stash negatives on session state so SCRIBE (and the
            # eventual SOAP / HPI rendering) can weave them into the
            # paragraph as "denies X, denies Y" — rules out can't-miss
            # diagnoses.
            state["pertinent_negatives"] = negatives
            log.info(
                "jackie coverage: covered=%s negatives=%s remaining=%s cc=%r gender=%r",
                sorted(covered), negatives, remaining[:4],
                (state.get("complaint_text") or "")[:60],
                state.get("gender"),
            )
            facts_block = render_facts_block(
                extract_disclosed_facts(
                    state.get("complaint_text") or None,
                    history_snapshot,
                )
            )
            text = await swarm.jackie.respond(
                patient_utterance,
                language=language,
                escalated=state["escalated"],
                history=history_snapshot,
                chief_complaint=state.get("complaint_text") or None,
                coverage_covered=covered,
                coverage_remaining=remaining,
                facts_block=facts_block,
            )
            # Redundancy guard — even with the COVERAGE block in the prompt,
            # the LoRA occasionally re-asks ground the patient already
            # answered (observed: asking about onset / severity / PMH after
            # the chief complaint already contained "started 24 hours ago",
            # "diabetes, high blood pressure"). Classify the LLM's question
            # against OPQRST/SAMPLE; if it targets a covered element, swap
            # in the canonical question for the first remaining priority.
            previous_jackie = next(
                (h.get("text") for h in reversed(history_snapshot)
                 if h.get("role") == "jackie"),
                None,
            )
            text, swapped = replace_if_redundant(
                text, covered, remaining,
                previous_jackie_question=previous_jackie,
                language=language,
            )
            if swapped:
                log.info(
                    "session=%s jackie redundancy: LLM asked covered ground, repeated prior question, or non-English language=%s; swapped to next-priority canonical",
                    session_id, language,
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
            # Incremental Helios refinement — every N completed turns,
            # re-submit the cumulative buffer for refined biomarker scores.
            # Runs as a background task so JACKIE's loop isn't blocked on
            # the Thymia round-trip.
            if turn >= 1 and turn % HELIOS_REFRESH_EVERY_N_TURNS == 0:
                asyncio.create_task(submit_helios_refresh())
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
    silence_task = asyncio.create_task(check_silence())
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
            "session=%s submitting %d frames (~%.1fs) to thymia (helios+apollo+psyche)",
            session_id, len(pcm_chunks), len(pcm_chunks) * 0.04,
        )
        # Fan out to all three thymia profiles in parallel. Helios is
        # the primary (drives concordance gating); Apollo (mood/energy)
        # and Psyche (affect breakdown) are surfaced on the dashboard
        # for the clinician but don't gate the triage path.
        full_text = _full_patient_text(state)
        result, apollo_result, psyche_result = await asyncio.gather(
            thymia.submit_helios(
                wav_bytes,
                user_label=session_id,
                date_of_birth=state["dob_iso"],
                language=state["helios_lang"],
                transcript=full_text,
            ),
            thymia.submit_apollo(
                wav_bytes,
                user_label=session_id,
                date_of_birth=state["dob_iso"],
                language=state["helios_lang"],
                transcript=full_text,
            ),
            thymia.submit_psyche(
                wav_bytes,
                user_label=session_id,
                date_of_birth=state["dob_iso"],
                language=state["helios_lang"],
                transcript=full_text,
            ),
            return_exceptions=True,
        )
        # Defensive: gather can return Exceptions if a coroutine raised.
        # We only treat HeliosResult as load-bearing — Apollo/Psyche
        # are progressive enhancement.
        if isinstance(result, Exception):
            log.exception("submit_helios raised", exc_info=result)
            result = None
        if isinstance(apollo_result, Exception):
            log.warning("submit_apollo raised: %s", apollo_result)
            apollo_result = None
        if isinstance(psyche_result, Exception):
            log.warning("submit_psyche raised: %s", psyche_result)
            psyche_result = None
        if not result:
            # Thymia API timeout or error — continue triage without biomarkers.
            # Concordance engine skips biomarker gating, uses transcript-only.
            log.warning("session=%s thymia returned no result — continuing without biomarkers", session_id)
            await bus.publish(room, {
                "type": "biomarker_unavailable",
                "data": {
                    "reason": "Voice biomarkers unavailable for this session",
                    "detail": "Thymia API timeout or error. Triage continues with transcript-only analysis.",
                    "session_id": session_id,
                },
            })
            # Still run concordance on transcript alone (no biomarker gating).
            await swarm.victor.on_concordance_evaluation(
                room=room,
                flags=[],
                transcript=state["latest_final_transcript"],
                biomarkers={},
                chief_complaint_label=None,
                chief_complaint_text=state.get("complaint_text"),
                pertinent_negatives=state.get("pertinent_negatives") or [],
                gender=state.get("gender"),
                age=_age_from_dob_iso(state.get("dob_iso")),
            )
            return

        event_data = result.to_event()
        helios_block = event_data.get("helios", {})
        # Merge Apollo + Psyche blocks into the same biomarker event so
        # the clinician dashboard receives one consolidated update with
        # all three thymia profiles. Concordance gating still keys off
        # Helios only — Apollo/Psyche are progressive enhancement.
        if apollo_result is not None:
            event_data.update(apollo_result.to_event())
        if psyche_result is not None:
            event_data.update(psyche_result.to_event())

        # Detect Thymia silent failure: all biomarker values are 0.0.
        if concordance_engine.biomarkers_all_zero({"helios": helios_block}):
            log.warning("session=%s all biomarker values are 0.0 — Thymia may have failed silently", session_id)
            await bus.publish(room, {
                "type": "biomarker_unavailable",
                "data": {"reason": "All biomarker values returned as zero — data may be unavailable"},
            })
            return

        await bus.publish(room, {"type": "biomarker", "data": event_data})

        # Track submission progress for incremental refresh.
        state["helios_submit_count"] += 1
        state["last_helios_submit_frames"] = len(pcm_chunks)

        # Run the concordance engine, then hand off to V.I.C.T.O.R. The
        # orchestrator publishes concordance_flag (with M.E.R.C.E.D. gloss),
        # esi_update, and soap_update events — and emits agent_activity for
        # the swarm panel along the way.
        #
        # CRITICAL: evaluate against the FULL patient text (chief complaint
        # + every patient turn from JACKIE history), not just the latest
        # final transcript. Live calibration on 2026-05-07 surfaced a silent
        # miss: the patient said "I don't wanna bother anyone, probably
        # nothing" in the chief complaint, but by the time biomarkers came
        # back the latest_final_transcript had rolled to a JACKIE follow-up
        # answer ("Well, when I see glaring lights..."). The engine was
        # asymmetric to the biomarker submission (which already used full
        # text via _full_patient_text), so the conjunction failed even
        # though both sides of it were present in the session — just not in
        # the same window. Use the same source as biomarker input.
        full_patient_text = _full_patient_text(state)
        flags = concordance_engine.evaluate(
            full_patient_text, {"helios": helios_block}
        )
        # If any concordance flag fires, mark the session as escalated so
        # subsequent J.A.C.K.I.E. turns use ESCALATED MODE (targeted cardiac
        # elicitation, framed as routine intake).
        if flags:
            state["escalated"] = True
        await swarm.victor.on_concordance_evaluation(
            room=room,
            flags=flags,
            transcript=full_patient_text,
            biomarkers={"helios": helios_block},
            chief_complaint_label=(flags[0].triage_label if flags else None),
            chief_complaint_text=state.get("complaint_text"),
            pertinent_negatives=state.get("pertinent_negatives") or [],
            gender=state.get("gender"),
            age=_age_from_dob_iso(state.get("dob_iso")),
        )

    # Re-run for biomarker refinement only — does NOT re-run concordance
    # evaluation (would spam new flags). Triggered after every N JACKIE
    # turns; publishes a fresh `biomarker` event that supersedes the
    # initial scores on the dashboard. Keeps the demo "live and refining"
    # rather than "single snapshot."
    helios_refresh_lock = asyncio.Lock()  # prevent overlapping refreshes

    async def submit_helios_refresh() -> None:
        # Only refresh if the initial submission already happened. The
        # initial path runs the concordance engine; refreshes only update
        # biomarkers.
        if state["helios_submit_count"] < 1:
            return
        if not thymia.enabled:
            return

        async with helios_refresh_lock:
            pcm_chunks: list[bytes] = list(state["complaint_pcm"])
            new_frames = len(pcm_chunks) - state["last_helios_submit_frames"]
            # Need at least ~10s of NEW audio since the last submit to be
            # worth re-running. Guards against rapid no-op refreshes.
            if new_frames < 250:
                log.info(
                    "session=%s helios refresh skipped — only %d new frames since last submit",
                    session_id, new_frames,
                )
                return
            log.info(
                "session=%s helios refresh: submitting %d frames (~%.1fs, +%d new) for biomarker refinement",
                session_id, len(pcm_chunks), len(pcm_chunks) * 0.04, new_frames,
            )

            wav_bytes = pcm16_to_wav(b"".join(pcm_chunks), settings.sample_rate_hz)
            full_text = _full_patient_text(state)
            # Same parallel fan-out on refresh — keep all three profiles
            # in sync so the dashboard never shows stale Apollo/Psyche
            # next to refreshed Helios.
            result, apollo_result, psyche_result = await asyncio.gather(
                thymia.submit_helios(
                    wav_bytes,
                    user_label=session_id,
                    date_of_birth=state["dob_iso"],
                    language=state["helios_lang"],
                    transcript=full_text,
                ),
                thymia.submit_apollo(
                    wav_bytes,
                    user_label=session_id,
                    date_of_birth=state["dob_iso"],
                    language=state["helios_lang"],
                    transcript=full_text,
                ),
                thymia.submit_psyche(
                    wav_bytes,
                    user_label=session_id,
                    date_of_birth=state["dob_iso"],
                    language=state["helios_lang"],
                    transcript=full_text,
                ),
                return_exceptions=True,
            )
            if isinstance(result, Exception):
                log.exception("submit_helios refresh raised", exc_info=result)
                result = None
            if isinstance(apollo_result, Exception):
                apollo_result = None
            if isinstance(psyche_result, Exception):
                psyche_result = None
            if not result:
                log.warning("session=%s helios refresh returned no result — keeping prior values", session_id)
                return

            event_data = result.to_event()
            helios_block = event_data.get("helios", {})
            if concordance_engine.biomarkers_all_zero({"helios": helios_block}):
                log.warning("session=%s helios refresh returned all-zero — keeping prior values", session_id)
                return

            # Merge Apollo + Psyche blocks into the refresh event too.
            if apollo_result is not None:
                event_data.update(apollo_result.to_event())
            if psyche_result is not None:
                event_data.update(psyche_result.to_event())
            # Tag as refreshed so the dashboard can display "refined" if it cares.
            event_data["refresh"] = True
            event_data["pass"] = state["helios_submit_count"] + 1
            await bus.publish(room, {"type": "biomarker", "data": event_data})
            state["helios_submit_count"] += 1
            state["last_helios_submit_frames"] = len(pcm_chunks)

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

                # Reset silence timer on any audio received.
                state["last_audio_time"] = time.time()
                state["silence_warned"] = False

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

                # Buffer audio while the patient is on the complaint OR
                # conversation phase. The same PCM accumulator feeds both
                # the initial Helios submission (at end of complaint) and
                # the incremental refresh runs (after every N JACKIE
                # turns). Cap at MAX_COMPLAINT_FRAMES to bound memory.
                if state["phase"] in ("complaint", "conversation"):
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
                # Include the payload for phase / identity_update events so
                # we can see exactly which transition the kiosk is in (helps
                # debug "stuck on X phase" reports without instrumenting the
                # frontend).
                if ptype in ("phase", "identity_update"):
                    log.info("client control: %s data=%s", ptype, payload.get("data"))
                else:
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
                    # against the captured chief complaint. Prefer the
                    # full complaint text (committed via identity_update
                    # from the editable textarea, includes every
                    # sentence the patient said) over the latest single
                    # final transcript — the latter would feed J.A.C.K.I.E.
                    # only the patient's last utterance and cause her
                    # to re-open with "what brought you in today?"
                    # because she'd have no context for what they said.
                    if new_phase == "conversation" and state["jackie_turn_count"] == 0:
                        seed = (
                            state["complaint_text"]
                            or state["latest_final_transcript"]
                            or "the patient's chief complaint"
                        )
                        helios_tasks.append(asyncio.create_task(
                            jackie_turn(seed, language=state["helios_lang"].split("-")[0])
                        ))

                # Patient tapped Send on the conversation-phase editable
                # textarea — fire J.A.C.K.I.E.'s next turn against the
                # (possibly hand-corrected) full text. This replaces the
                # old transcript-final auto-trigger so STT mistranscriptions
                # don't poison J.A.C.K.I.E.'s reasoning. We still respect
                # turn count, busy guard, and emergency state.
                if ptype == "conversation_answer":
                    answer_data = payload.get("data") or {}
                    answer_text = (answer_data.get("text") or "").strip()
                    answer_lang = answer_data.get("language") or state["helios_lang"].split("-")[0]
                    if (
                        answer_text
                        and state["phase"] == "conversation"
                        and not state["jackie_busy"]
                        and not state["emergency_fired"]
                        and state["jackie_turn_count"] < state["jackie_max_turns"]
                    ):
                        helios_tasks.append(
                            asyncio.create_task(jackie_turn(answer_text, answer_lang))
                        )

                # Capture the confirmed DOB from identity_update so Helios
                # can include it on the model run. Also detect minor patients.
                if ptype == "identity_update":
                    id_data = payload.get("data") or {}
                    dob = id_data.get("dob")
                    if dob:
                        iso = dob_to_iso(dob)
                        if iso:
                            state["dob_iso"] = iso
                    if id_data.get("is_minor"):
                        state["is_minor"] = True
                    # Capture the full chief complaint when the kiosk
                    # commits the complaint phase (the textarea contents,
                    # which may span multiple sentences after edits). This
                    # is what J.A.C.K.I.E. should reason about — using
                    # latest_final_transcript instead would only give
                    # her the patient's last sentence, which causes her
                    # to re-ask the chief-complaint question because she
                    # has no context for what the patient just said.
                    complaint = id_data.get("complaint")
                    if complaint and isinstance(complaint, str) and complaint.strip():
                        state["complaint_text"] = complaint.strip()
                        # If the chief complaint suggests cardiac, compute
                        # a clinical (pre-EKG, pre-troponin) HEART score
                        # right at intake. The clinician sees a risk-strat
                        # number on the chart while ECG and troponin are
                        # being ordered — anchors expectations early.
                        # Score updates as the conversation accumulates
                        # (we recompute on every J.A.C.K.I.E. turn below).
                        # Same helper publishes Wells/PE for SOB cases
                        # and Alvarado for abdominal pain cases — only
                        # the score(s) whose CC trigger fires are sent.
                        asyncio.create_task(_publish_risk_scores(
                            bus, room, state, complaint,
                            age=_age_from_dob_iso(state.get("dob_iso")),
                        ))
                        # Fire SCRIBE's chief-complaint distillation in the
                        # background. Result lands as a follow-up
                        # identity_update with a `chief_complaint_short`
                        # field so the clinician dashboard can render a
                        # clean chart-header line ("Chest pain x 24h")
                        # instead of the patient's full narrative. Doesn't
                        # block the SOAP / Helios / J.A.C.K.I.E. paths.
                        async def _distill_and_publish(text: str) -> None:
                            try:
                                short = await swarm.scribe.summarize_cc(text)
                            except Exception:
                                log.exception("scribe summarize_cc raised")
                                return
                            if not short:
                                return
                            state["complaint_short"] = short
                            await bus.publish(room, {
                                "type": "identity_update",
                                "data": {"chief_complaint_short": short},
                            })
                        helios_tasks.append(
                            asyncio.create_task(_distill_and_publish(complaint.strip()))
                        )
                    # Capture sex assigned at birth — it biases the
                    # coverage-tracker priority list (e.g. abdominal
                    # pain in a female-bodied patient front-loads LMP
                    # for the ectopic-pregnancy can't-miss).
                    gender = id_data.get("gender")
                    if gender and isinstance(gender, str) and gender.strip():
                        state["gender"] = gender.strip()
                    # Non-verbal patient: skip voice triage entirely.
                    if id_data.get("non_verbal"):
                        await bus.publish(room, {
                            "type": "session_status",
                            "data": {
                                "status": "non_verbal",
                                "reason": "Non-verbal patient — manual triage required",
                                "session_id": session_id,
                            },
                        })

    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("ws error room=%s session=%s", room, session_id)
    finally:
        heartbeat_task.cancel()
        relay_task.cancel()
        silence_task.cancel()
        # Browser tab closed mid-triage → notify clinician dashboard.
        if not state["session_abandoned"] and state["phase"] in ("complaint", "conversation"):
            await bus.publish(room, {
                "type": "session_status",
                "data": {
                    "status": "interrupted",
                    "reason": "WebSocket closed mid-triage (browser tab closed or network drop)",
                    "session_id": session_id,
                    "phase": state["phase"],
                    "turns_completed": state["jackie_turn_count"],
                },
            })
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
    except RuntimeError as e:
        # FastAPI/Starlette throws RuntimeError when send is called on a
        # WS that already received a close frame. Common during HMR
        # remounts or rapid tab refreshes — treat as a normal disconnect.
        if "close" in str(e).lower():
            log.debug("clinician ws closed mid-send room=%s", room)
        else:
            log.exception("clinician ws error room=%s", room)
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
    except (asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
        # RuntimeError fires from Starlette when sending after the WS
        # has already received a close frame — common during HMR
        # remounts. Treat all three as normal terminations.
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
    except (asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
        return
    except Exception:
        log.debug("heartbeat ended", exc_info=True)
