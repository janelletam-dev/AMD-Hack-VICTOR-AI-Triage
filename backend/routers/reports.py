"""REST: /api/report — E.L.M.E.R. evidence synthesis.

The session log is read from the server-side `SessionLogStore` keyed by
room_id, so the report works from any device — not just the browser that
ran the demo. The legacy `session_log` body field is still accepted as an
override for backwards compatibility, but new callers should omit it.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agents import swarm
from services.session_log_store import store as session_log_store

router = APIRouter(prefix="/api", tags=["reports"])

REFERENCES_PATH = Path(__file__).parent.parent / "prompts" / "references.json"


class ReportRequest(BaseModel):
    room_id: str
    # Backwards-compat: legacy frontends used to ship the entire session log
    # in the request body. New flow is server-authoritative — leave this None
    # to read from the store.
    session_log: dict | None = None


class ReportResponse(BaseModel):
    report: str
    esi_standard: int
    esi_adjusted: int
    flags: list[dict]
    biomarker_summary: dict
    soap_note: dict
    agent: str = "E.L.M.E.R."


def _is_populated(log: dict) -> bool:
    """Return True if the log has any clinically meaningful content.

    Used to decide whether to trust the server-side store or fall back to
    the request body (e.g. the frontend "Run Demo" flow which fires
    setTimeout-driven events without ever hitting the WS backend)."""
    if not log:
        return False
    return bool(
        log.get("transcript_lines")
        or log.get("flags")
        or log.get("soap")
        or log.get("esi")
        or log.get("identity")
        or log.get("biomarker_summary")
        or log.get("emergency")
    )


@router.post("/report", response_model=ReportResponse)
async def generate_report(req: ReportRequest) -> ReportResponse:
    if not req.room_id:
        raise HTTPException(status_code=400, detail="room_id required")

    server_log = session_log_store.get(req.room_id).to_dict()
    if _is_populated(server_log):
        session_log = server_log
    elif req.session_log is not None:
        # Demo / device-without-WS fallback. Real triage sessions always
        # populate the server store via the EventBus tap, so this branch is
        # only hit by the front-end demo (which fakes events client-side).
        session_log = req.session_log
    else:
        session_log = server_log  # empty, but pass through so E.L.M.E.R. can fall back gracefully

    result = await swarm.elmer.synthesize(session_log)
    return ReportResponse(**result)


class IdentityUpdate(BaseModel):
    name: str | None = None
    dob: str | None = None
    complaint: str | None = None


@router.post("/identity/{room_id}")
async def update_identity(room_id: str, body: IdentityUpdate) -> dict:
    """Clinician-side correction of voice-captured identity.

    Updates the per-room SessionLogStore (so /api/report sees the corrected
    values) and republishes an `identity_update` event on the bus (so any
    live patient / EMR subscribers also re-render with the correction).
    """
    if not room_id:
        raise HTTPException(status_code=400, detail="room_id required")
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="no fields provided")

    fields["source"] = "clinician_edit"
    # Lazy import to keep this router decoupled from event_bus at import time.
    from services.event_bus import bus
    await bus.publish(room_id, {"type": "identity_update", "data": fields})

    return {"ok": True, "room_id": room_id, "applied": fields}


@router.get("/references")
async def get_references() -> dict:
    """Return the static references library that grounds V.I.C.T.O.R.'s clinical
    reasoning. Surfaced in the EvidenceReport UI so the citations stay visible
    even when the LLM is unreachable and E.L.M.E.R. falls back to a deterministic
    template (which omits inline citations).
    """
    try:
        return json.loads(REFERENCES_PATH.read_text())
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="references.json missing")


@router.get("/session/{room_id}")
async def get_session(room_id: str) -> dict:
    """Read the current rolling session log for a room.

    Useful for debugging the report's input and for any non-clinician view
    that wants to preview triage state without re-running the WS fan-out.
    """
    if not session_log_store.has(room_id):
        raise HTTPException(
            status_code=404,
            detail=f"no session log for room {room_id!r}",
        )
    return session_log_store.get(room_id).to_dict()
