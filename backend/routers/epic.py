"""REST: /api/epic — chart push to the Epic EHR.

Demo-fidelity: there's no live Epic instance to integrate with, so the
"push" is a server-side bundle build + receipt. We assemble a FHIR R4
Bundle from the rolling session log (Encounter, DocumentReference,
Observations for biomarkers + ESI, Flag for any concordance gaps) and
record the push in the session_log_store so the EMR view can show a
"Posted at …" banner instead of looking like a still-streaming chart.

The FHIR bundle is recognisable enough that a clinician auditor can see
the shape we'd POST to a real Epic FHIR endpoint — but we never actually
call out. To wire to a real Epic instance, swap `_fake_post()` for a
real OAuth2-authenticated POST to the Epic /Bundle endpoint.
"""
from __future__ import annotations

import time
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.session_log_store import store as session_log_store

router = APIRouter(prefix="/api/epic", tags=["epic"])


class PushRequest(BaseModel):
    room_id: str
    # Identity fed in from the dashboard's local store overrides whatever
    # the server has — clinician edits land in the FE first and only sync
    # back over POST /api/identity. Pass the corrected snapshot through.
    identity: dict[str, Any] | None = None
    # Optional clinician note appended to the DocumentReference text. Lets
    # the clinician add a one-line "thumbs up" or caveat at sign-off time.
    clinician_note: str | None = None


class PushResponse(BaseModel):
    ok: bool
    doc_id: str
    posted_at: float
    bundle_size: int
    summary: dict[str, Any]


def _isoformat(epoch_s: float) -> str:
    """FHIR dateTime — RFC 3339 with Z suffix."""
    t = time.gmtime(epoch_s)
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", t)


def _build_fhir_bundle(session: dict[str, Any], identity_override: dict | None,
                       clinician_note: str | None) -> dict[str, Any]:
    """Compose a FHIR R4 Bundle from a session log.

    Resources included (in order):
      1. Patient — name, dob, gender pulled from identity
      2. Encounter — links to the patient, ED triage class
      3. Observation × N — voice biomarkers (Helios stress/distress/etc.)
      4. Flag × N — one per concordance flag with tier as severity
      5. DocumentReference — the SOAP note as a clinical doc
    """
    identity = {**(session.get("identity") or {}), **(identity_override or {})}
    soap = session.get("soap") or {}
    esi = session.get("esi") or {}
    flags = session.get("flags") or []
    biomarker_summary = session.get("biomarker_summary") or {}
    helios = biomarker_summary.get("helios") or {}

    patient_id = f"urn:uuid:{uuid.uuid4()}"
    encounter_id = f"urn:uuid:{uuid.uuid4()}"
    posted_at = time.time()
    posted_iso = _isoformat(posted_at)

    name_parts = (identity.get("name") or "").strip().split()
    family = name_parts[-1] if name_parts else ""
    given = name_parts[:-1] if len(name_parts) > 1 else name_parts

    gender_raw = (identity.get("gender") or "").lower()
    gender_map = {"male": "male", "female": "female", "non-binary": "other"}
    gender = gender_map.get(gender_raw, "unknown") if gender_raw else "unknown"

    entries: list[dict[str, Any]] = []

    # 1. Patient
    entries.append({
        "fullUrl": patient_id,
        "resource": {
            "resourceType": "Patient",
            "name": [{"family": family, "given": given}] if (family or given) else [],
            "birthDate": identity.get("dob") or None,
            "gender": gender,
        },
    })

    # 2. Encounter
    cc_short = identity.get("chief_complaint_short") or identity.get("complaint") or ""
    encounter: dict[str, Any] = {
        "resourceType": "Encounter",
        "status": "in-progress",
        "class": {
            "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
            "code": "EMER",
            "display": "emergency",
        },
        "subject": {"reference": patient_id},
        "period": {"start": _isoformat(session.get("started_at") or posted_at)},
    }
    if cc_short:
        encounter["reasonCode"] = [{"text": cc_short[:120]}]
    if esi:
        std = esi.get("standard")
        adj = esi.get("adjusted")
        encounter["priority"] = {
            "text": f"ESI {adj or std or 'pending'}"
                    + (f" (V.I.C.T.O.R. adjusted from {std})" if std and adj and adj < std else "")
        }
    entries.append({"fullUrl": encounter_id, "resource": encounter})

    # 3. Observations — voice biomarkers
    biomarker_keys = ("stress", "distress", "mentalStrain", "exhaustion", "lowSelfEsteem")
    for k in biomarker_keys:
        v = helios.get(k)
        if not isinstance(v, (int, float)):
            continue
        entries.append({
            "fullUrl": f"urn:uuid:{uuid.uuid4()}",
            "resource": {
                "resourceType": "Observation",
                "status": "final",
                "category": [{
                    "coding": [{
                        "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                        "code": "survey",
                        "display": "Survey",
                    }],
                }],
                "code": {"text": f"Voice biomarker · Helios {k}"},
                "subject": {"reference": patient_id},
                "encounter": {"reference": encounter_id},
                "effectiveDateTime": posted_iso,
                "valueQuantity": {"value": round(float(v), 4), "unit": "score"},
            },
        })

    # 4. Flag resources for concordance gaps
    for f in flags:
        tier = f.get("tier") or 3
        severity = "high" if tier == 1 else "moderate" if tier == 2 else "low"
        entries.append({
            "fullUrl": f"urn:uuid:{uuid.uuid4()}",
            "resource": {
                "resourceType": "Flag",
                "status": "active",
                "category": [{"text": "Clinical · concordance"}],
                "code": {
                    "text": f.get("triage_label") or "Atypical-presentation concordance flag",
                },
                "subject": {"reference": patient_id},
                "encounter": {"reference": encounter_id},
                "extension": [
                    {"url": "victor:tier",            "valueInteger": int(tier)},
                    {"url": "victor:severity",        "valueString": severity},
                    {"url": "victor:trigger_phrase",  "valueString": f.get("trigger_phrase") or ""},
                    {"url": "victor:evidence_basis",  "valueString": f.get("evidence_basis") or ""},
                ],
            },
        })

    # 5. DocumentReference — SOAP note
    soap_text_parts: list[str] = []
    if soap.get("subjective"):
        soap_text_parts.append(f"S: {soap['subjective']}")
    if soap.get("objective"):
        soap_text_parts.append(f"O: {soap['objective']}")
    if soap.get("assessment"):
        soap_text_parts.append(f"A: {soap['assessment']}")
    plan = soap.get("plan") or []
    if isinstance(plan, list) and plan:
        soap_text_parts.append("P:\n" + "\n".join(f"  - {p}" for p in plan))
    if clinician_note:
        soap_text_parts.append(f"\nClinician note: {clinician_note}")
    soap_text = "\n\n".join(soap_text_parts) if soap_text_parts else "(SOAP pending)"

    entries.append({
        "fullUrl": f"urn:uuid:{uuid.uuid4()}",
        "resource": {
            "resourceType": "DocumentReference",
            "status": "current",
            "docStatus": "preliminary",
            "type": {
                "coding": [{
                    "system": "http://loinc.org",
                    "code": "34117-2",
                    "display": "History and physical note",
                }],
            },
            "subject": {"reference": patient_id},
            "context": {"encounter": [{"reference": encounter_id}]},
            "date": posted_iso,
            "author": [{"display": "V.I.C.T.O.R. + S.C.R.I.B.E."}],
            "description": cc_short or "ED triage note",
            "content": [{
                "attachment": {
                    "contentType": "text/plain",
                    "data": soap_text,
                    "title": "SOAP note (S.C.R.I.B.E. draft)",
                },
            }],
        },
    })

    bundle = {
        "resourceType": "Bundle",
        "type": "transaction",
        "timestamp": posted_iso,
        "entry": entries,
    }
    return bundle


@router.post("/push", response_model=PushResponse)
async def push_to_epic(req: PushRequest) -> PushResponse:
    if not req.room_id:
        raise HTTPException(status_code=400, detail="room_id required")

    session = session_log_store.get(req.room_id).to_dict()
    bundle = _build_fhir_bundle(session, req.identity, req.clinician_note)

    doc_id = f"VICTOR-{int(time.time())}-{uuid.uuid4().hex[:6].upper()}"
    posted_at = time.time()
    summary = {
        "patient": (req.identity or session.get("identity") or {}).get("name") or "—",
        "esi_adjusted": (session.get("esi") or {}).get("adjusted"),
        "esi_standard": (session.get("esi") or {}).get("standard"),
        "flags": len(session.get("flags") or []),
        "soap_sections": [k for k, v in (session.get("soap") or {}).items() if v],
        "biomarkers_present": bool((session.get("biomarker_summary") or {}).get("helios")),
    }

    log_obj = session_log_store.get(req.room_id)
    log_obj.epic_push = {
        "doc_id": doc_id,
        "posted_at": posted_at,
        "bundle": bundle,
        "summary": summary,
        "clinician_note": req.clinician_note,
    }
    log_obj.updated_at = posted_at

    return PushResponse(
        ok=True,
        doc_id=doc_id,
        posted_at=posted_at,
        bundle_size=len(bundle["entry"]),
        summary=summary,
    )


@router.get("/bundle/{room_id}")
async def get_bundle(room_id: str) -> dict:
    """Download the FHIR bundle generated at push time. Returns 404 if the
    chart hasn't been pushed yet — the bundle is built on push, not on
    demand, so the bytes match exactly what was 'sent' to Epic."""
    if not session_log_store.has(room_id):
        raise HTTPException(status_code=404, detail=f"no session for room {room_id!r}")
    log_obj = session_log_store.get(room_id)
    push = log_obj.epic_push
    if not push:
        raise HTTPException(status_code=404, detail="chart not yet pushed to Epic")
    return push.get("bundle") or {}


@router.get("/receipt/{room_id}")
async def get_receipt(room_id: str) -> dict:
    """Return the push receipt (doc_id, posted_at, summary). Lighter than
    /bundle — the EMR view's banner reads from this, not the full bundle."""
    if not session_log_store.has(room_id):
        raise HTTPException(status_code=404, detail=f"no session for room {room_id!r}")
    push = session_log_store.get(room_id).epic_push
    if not push:
        return {"pushed": False}
    return {
        "pushed": True,
        "doc_id": push["doc_id"],
        "posted_at": push["posted_at"],
        "summary": push.get("summary") or {},
        "clinician_note": push.get("clinician_note"),
    }
