"""REST: /api/clinician — bedside collaboration with the V.I.C.T.O.R. swarm.

The kiosk captures voice triage. It cannot observe vitals, physical
exam, ECG, labs, or any data that requires hands-on contact with the
patient. This router is the path by which the bedside clinician adds
that missing context — vitals, exam findings, additional history, a
working differential, plan modifications — and the swarm folds it
into the SOAP so the chart is the *combined* output of V.I.C.T.O.R.
and the clinician.

POST /api/clinician/addendum/{room_id}
    Accepts a structured bedside addendum, stores it on the session
    log, triggers SCRIBE to recompose the SOAP with the new context,
    and publishes the resulting soap_update event to the room's bus.
    The dashboard's SOAPCard re-renders with the clinician's
    contributions visible.

GET /api/clinician/addendum/{room_id}
    Returns the current addendum (or {pushed: false} if none).
"""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from agents import swarm
from services.event_bus import bus
from services.session_log_store import store as session_log_store

router = APIRouter(prefix="/api/clinician", tags=["clinician"])


class Vitals(BaseModel):
    bp: str | None = None
    hr: str | None = None
    rr: str | None = None
    spo2: str | None = None
    temp: str | None = None
    pain: str | None = None


class AddendumRequest(BaseModel):
    vitals: Vitals | None = None
    physical_exam: str | None = None
    additional_history: str | None = None
    bedside_assessment: str | None = None
    plan_addendum: list[str] | None = None
    clinician: str | None = Field(
        default=None,
        description="Optional clinician name or role for the chart attribution",
    )


def _vitals_summary(v: Vitals | dict | None) -> str:
    """Render vitals as a single-line clinician-friendly string."""
    if not v:
        return ""
    if isinstance(v, dict):
        bp = v.get("bp"); hr = v.get("hr"); rr = v.get("rr")
        spo2 = v.get("spo2"); temp = v.get("temp"); pain = v.get("pain")
    else:
        bp = v.bp; hr = v.hr; rr = v.rr; spo2 = v.spo2; temp = v.temp; pain = v.pain
    parts: list[str] = []
    if bp: parts.append(f"BP {bp}")
    if hr: parts.append(f"HR {hr}")
    if rr: parts.append(f"RR {rr}")
    if spo2: parts.append(f"SpO2 {spo2}%" if not str(spo2).endswith("%") else f"SpO2 {spo2}")
    if temp: parts.append(f"Temp {temp}°F" if not str(temp).endswith("F") else f"Temp {temp}")
    if pain: parts.append(f"Pain {pain}/10" if "/" not in str(pain) else f"Pain {pain}")
    return ", ".join(parts)


@router.post("/addendum/{room_id}")
async def post_addendum(room_id: str, body: AddendumRequest) -> dict:
    if not room_id:
        raise HTTPException(status_code=400, detail="room_id required")

    log_obj = session_log_store.get(room_id)

    # Persist the addendum on the session log (overwrites prior — the
    # clinician edits are progressive within a single encounter).
    addendum: dict[str, Any] = {
        "vitals": body.vitals.model_dump() if body.vitals else None,
        "vitals_summary": _vitals_summary(body.vitals),
        "physical_exam": (body.physical_exam or "").strip() or None,
        "additional_history": (body.additional_history or "").strip() or None,
        "bedside_assessment": (body.bedside_assessment or "").strip() or None,
        "plan_addendum": [p.strip() for p in (body.plan_addendum or []) if p.strip()] or None,
        "clinician": (body.clinician or "").strip() or None,
        "updated_at": time.time(),
    }
    log_obj.clinician_addendum = addendum
    log_obj.updated_at = time.time()

    # Broadcast the addendum so the dashboard can immediately reflect it
    # (e.g., highlight clinician-added Vitals tile) without waiting for
    # SCRIBE to finish recomposing the SOAP.
    await bus.publish(
        room_id,
        {"type": "clinician_addendum", "data": addendum},
    )

    # Recompose the SOAP with the clinician addendum folded into the
    # context. SCRIBE preserves prior LLM output and merges the new
    # bedside context — see scribe_system.txt for the merge rules.
    biomarkers = log_obj.biomarker_summary or {}
    flags = log_obj.flags or []
    esi = log_obj.esi or {}
    identity = log_obj.identity or {}

    transcript_lines = log_obj.transcript_lines or []
    transcript = " ".join(t.get("text", "") for t in transcript_lines if t.get("text"))

    pertinent_negs: list[str] = []
    # Reuse existing pertinent negatives from prior SCRIBE updates if
    # the log carries them in metadata; the addendum doesn't usually
    # include negatives directly.
    for line in transcript_lines:
        n = line.get("pertinent_negatives")
        if isinstance(n, list):
            pertinent_negs.extend(n)

    age = None
    dob = identity.get("dob")
    if dob and isinstance(dob, str) and len(dob) >= 4:
        try:
            from datetime import date
            y, m, d = (int(p) for p in dob.split("-")[:3])
            today = date.today()
            age = today.year - y - ((today.month, today.day) < (m, d))
            if age < 0 or age > 150:
                age = None
        except (ValueError, IndexError):
            age = None

    ctx = {
        "transcript": transcript,
        "biomarkers": biomarkers,
        "flags": flags,
        "esi": esi,
        "chief_complaint_text": identity.get("complaint"),
        "chief_complaint_short": identity.get("chief_complaint_short"),
        "pertinent_negatives": pertinent_negs,
        "gender": identity.get("gender"),
        "age": age,
        "clinician_addendum": addendum,  # ← the new collaboration channel
    }

    note = await swarm.scribe.update(ctx)
    log_obj.soap = note.to_dict()

    await bus.publish(
        room_id,
        {
            "type": "soap_update",
            "data": {**note.to_dict(), "ready": True, "agent": swarm.scribe.name},
        },
    )

    return {
        "ok": True,
        "addendum": addendum,
        "soap": note.to_dict(),
    }


@router.get("/addendum/{room_id}")
async def get_addendum(room_id: str) -> dict:
    if not session_log_store.has(room_id):
        return {"present": False}
    addendum = session_log_store.get(room_id).clinician_addendum
    if not addendum:
        return {"present": False}
    return {"present": True, **addendum}
