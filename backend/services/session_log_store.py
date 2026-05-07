"""Per-room rolling session log.

Mirrors what the frontend's `sessionLogStore.js` keeps in memory, but
authoritative on the server. Powers `/api/report` so a clinician on any
device can request the report without depending on a particular browser
having seen every WS event.

Lives for the lifetime of the process. No persistence — restart wipes the
store. That's fine for the demo; swap to Redis when we need cross-restart
durability.

Writes happen automatically via `EventBus.publish()` — every event the bus
emits is also tee'd into the matching room's log. Routers don't need to
remember to call into here.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("victor.session_log")

# Cap the rolling transcript so a long-running room doesn't blow memory.
# 200 lines ≈ a few thousand spoken words, comfortably more than any
# realistic triage interview.
TRANSCRIPT_CAP = 200

# Event types we mirror into the session log. Anything not listed here
# (agent_activity, jackie_turn, heartbeat, etc.) is ignored — only data
# that ends up in the evidence report belongs in the log.
_TRACKED_TYPES = frozenset({
    "transcript",
    "biomarker",
    "concordance_flag",
    "soap_update",
    "esi_update",
    "identity_update",
    "triage_emergency",
    "triage_complete",
})


@dataclass
class SessionLog:
    """The same shape the frontend's sessionLogStore exposes."""
    room_id: str
    transcript_lines: list[dict[str, Any]] = field(default_factory=list)
    biomarker_summary: dict[str, Any] | None = None
    flags: list[dict[str, Any]] = field(default_factory=list)
    soap: dict[str, Any] = field(default_factory=dict)
    esi: dict[str, Any] = field(default_factory=dict)
    identity: dict[str, Any] = field(default_factory=dict)
    emergency: dict[str, Any] | None = None
    triage_complete: bool = False
    # Receipt populated when the clinician pushes the chart to Epic.
    # Carries doc_id, posted_at (epoch s), and a small bundle summary so
    # the EMR view can show a "Posted at …" banner without re-fetching
    # the full FHIR document.
    epic_push: dict[str, Any] | None = None
    # Bedside data the kiosk cannot capture — vitals, physical exam,
    # additional history, and clinician's bedside assessment + plan
    # additions. Populated via POST /api/clinician/addendum from the
    # dashboard. SCRIBE merges this into the SOAP so V.I.C.T.O.R. and
    # the clinician arrive at the chart collaboratively. Schema:
    #   {
    #     "vitals": {"bp": "142/88", "hr": "94", "rr": "18", "spo2": "96",
    #                "temp": "98.4", "pain": "6"},
    #     "physical_exam": "<free text or by-system>",
    #     "additional_history": "<anything kiosk missed>",
    #     "bedside_assessment": "<clinician's working differential>",
    #     "plan_addendum": ["<extra plan items>"],
    #     "updated_at": <epoch s>,
    #     "clinician": "<name or role, optional>"
    #   }
    clinician_addendum: dict[str, Any] | None = None
    started_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "room_id": self.room_id,
            "transcript_lines": self.transcript_lines,
            "biomarker_summary": self.biomarker_summary,
            "flags": self.flags,
            "soap": self.soap,
            "esi": self.esi,
            "identity": self.identity,
            "emergency": self.emergency,
            "triage_complete": self.triage_complete,
            "epic_push": self.epic_push,
            "clinician_addendum": self.clinician_addendum,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        }


class SessionLogStore:
    def __init__(self) -> None:
        self._rooms: dict[str, SessionLog] = {}

    def get(self, room_id: str) -> SessionLog:
        log_obj = self._rooms.get(room_id)
        if log_obj is None:
            log_obj = SessionLog(room_id=room_id)
            self._rooms[room_id] = log_obj
        return log_obj

    def has(self, room_id: str) -> bool:
        return room_id in self._rooms

    def clear(self, room_id: str) -> None:
        self._rooms.pop(room_id, None)

    def reset(self, room_id: str) -> SessionLog:
        """Wipe and re-seed an empty log — used when a room starts a fresh
        triage session and we don't want stale data in the report."""
        fresh = SessionLog(room_id=room_id)
        self._rooms[room_id] = fresh
        return fresh

    def all_room_ids(self) -> list[str]:
        return list(self._rooms.keys())

    def ingest(self, room_id: str, event: dict[str, Any]) -> None:
        """Mirror a published event into the log if its type is tracked.

        Called from `EventBus.publish()` so every emit site contributes
        without having to remember to write here directly.
        """
        etype = event.get("type")
        if etype not in _TRACKED_TYPES:
            return
        data = event.get("data") or {}
        log_obj = self.get(room_id)

        if etype == "transcript":
            # Only finalised lines belong in the report. Partials would
            # bloat the log with throwaway words.
            if not data.get("is_final") or not data.get("text"):
                return
            log_obj.transcript_lines.append({
                "text": data.get("text", ""),
                "language": data.get("language"),
                "is_final": True,
                "ts": time.time(),
            })
            if len(log_obj.transcript_lines) > TRANSCRIPT_CAP:
                log_obj.transcript_lines = log_obj.transcript_lines[-TRANSCRIPT_CAP:]

        elif etype == "biomarker":
            log_obj.biomarker_summary = data

        elif etype == "concordance_flag":
            # Dedupe by (tier, triage_label, trigger_phrase). On a repeat,
            # bump repeat_count instead of appending a duplicate row.
            key = (
                data.get("tier"),
                data.get("triage_label", ""),
                data.get("trigger_phrase", ""),
            )
            for existing in log_obj.flags:
                if (
                    existing.get("tier"),
                    existing.get("triage_label", ""),
                    existing.get("trigger_phrase", ""),
                ) == key:
                    existing["repeated"] = True
                    existing["repeat_count"] = existing.get("repeat_count", 1) + 1
                    break
            else:
                log_obj.flags.append(dict(data))

        elif etype == "soap_update":
            log_obj.soap = dict(data)

        elif etype == "esi_update":
            # Normalise to the shape the report wants: standard / adjusted / reason.
            log_obj.esi = {
                "standard": data.get("standard_esi", log_obj.esi.get("standard")),
                "adjusted": data.get("victor_esi", log_obj.esi.get("adjusted")),
                "reason": data.get("adjustment_reason", log_obj.esi.get("reason")),
            }

        elif etype == "identity_update":
            log_obj.identity = {**log_obj.identity, **data}

        elif etype == "triage_emergency":
            log_obj.emergency = data

        elif etype == "triage_complete":
            log_obj.triage_complete = True

        log_obj.updated_at = time.time()


store = SessionLogStore()
