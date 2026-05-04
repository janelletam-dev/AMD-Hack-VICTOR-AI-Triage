"""REST: /api/report — E.L.M.E.R. evidence synthesis.

Day 1: stubbed. Wired to E.L.M.E.R. on Day 4.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["reports"])


class ReportRequest(BaseModel):
    room_id: str


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
    # TODO(Day 4): wire to E.L.M.E.R. agent + EventBus session log
    return ReportResponse(
        report="Evidence report generation pending — see Day 4 milestone.",
        esi_standard=0,
        esi_adjusted=0,
        flags=[],
        biomarker_summary={},
        soap_note={},
    )
