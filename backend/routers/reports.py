"""REST: /api/report — E.L.M.E.R. evidence synthesis."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agents import swarm

router = APIRouter(prefix="/api", tags=["reports"])


class ReportRequest(BaseModel):
    room_id: str
    # Optional session log payload from the client. The frontend already has
    # the running transcript, biomarkers, flags and SOAP in memory; passing
    # them here saves us building a server-side per-room session store today.
    session_log: dict | None = None


class ReportResponse(BaseModel):
    report: str
    esi_standard: int
    esi_adjusted: int
    flags: list[dict]
    biomarker_summary: dict
    soap_note: dict
    agent: str = "E.L.M.E.R."


@router.post("/report", response_model=ReportResponse)
async def generate_report(req: ReportRequest) -> ReportResponse:
    if not req.room_id:
        raise HTTPException(status_code=400, detail="room_id required")
    session_log = req.session_log or {}
    result = await swarm.elmer.synthesize(session_log)
    return ReportResponse(**result)
