// In-memory rolling session log. The clinician dashboard + EMR view feed it
// from their WS event handlers; the EvidenceReport page reads from it to
// build the body of POST /api/report.
//
// Lives for the lifetime of the page. A hard refresh clears it. Same
// trade-off as identityStore — server-side persistence is a Day 5 task.

import { useEffect, useState } from "react";

function _initial() {
  return {
    transcript_lines: [],   // [ { text, language, is_final, ts } ]
    biomarker_summary: null, // last `biomarker.data` payload
    flags: [],              // concordance_flag.data payloads (deduped)
    soap: {},               // last soap_update.data
    esi: {},                // last esi_update.data → { standard, adjusted, reason }
    identity: {},           // mirrored from identityStore
    emergency: null,        // triage_emergency.data, if fired
    triage_complete: false,
  };
}

let _state = _initial();
const _subs = new Set();

function _notify() {
  _subs.forEach((fn) => { try { fn(_state); } catch { /* swallow */ } });
}

export function getSessionLog() {
  return _state;
}

export function clearSessionLog() {
  _state = _initial();
  _notify();
}

export function appendTranscript({ text, language, is_final }) {
  if (!is_final || !text) return;
  _state = {
    ..._state,
    transcript_lines: [
      ..._state.transcript_lines,
      { text, language, is_final, ts: Date.now() },
    ].slice(-200),  // cap so very long sessions don't blow memory
  };
  _notify();
}

export function setBiomarkerSummary(data) {
  _state = { ..._state, biomarker_summary: data };
  _notify();
}

export function appendFlag(flagData) {
  // Dedupe: if a flag with the same (tier, triage_label, trigger_phrase)
  // already exists, mark it `repeated: true` instead of pushing a duplicate.
  const key = (f) => `${f.tier}::${f.triage_label || ""}::${f.trigger_phrase || ""}`;
  const newKey = key(flagData);
  const existing = _state.flags.findIndex((f) => key(f) === newKey);
  let next;
  if (existing >= 0) {
    next = _state.flags.map((f, i) =>
      i === existing
        ? { ...f, repeated: true, repeat_count: (f.repeat_count || 1) + 1 }
        : f
    );
  } else {
    next = [..._state.flags, flagData];
  }
  _state = { ..._state, flags: next };
  _notify();
}

export function setSOAP(data) {
  _state = { ..._state, soap: data };
  _notify();
}

export function setESI(data) {
  _state = {
    ..._state,
    esi: {
      standard: data.standard_esi ?? data.standard ?? _state.esi.standard,
      adjusted: data.victor_esi ?? data.adjusted ?? _state.esi.adjusted,
      reason: data.adjustment_reason ?? data.reason ?? _state.esi.reason,
    },
  };
  _notify();
}

export function setIdentity(identity) {
  _state = { ..._state, identity: { ..._state.identity, ...identity } };
  _notify();
}

export function setEmergency(data) {
  _state = { ..._state, emergency: data };
  _notify();
}

export function setTriageComplete(complete = true) {
  _state = { ..._state, triage_complete: !!complete };
  _notify();
}

export function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

export function useSessionLog() {
  const [s, setS] = useState(_state);
  useEffect(() => subscribe(setS), []);
  return s;
}
