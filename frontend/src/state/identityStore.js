// In-memory identity store, shared across patient / clinician / EMR views.
// Lives for the lifetime of the page — a hard refresh clears it.
//
// Tracks two snapshots so the UI can surface clinician corrections:
//   _state    — current values (what the dashboard, banner, report show)
//   _original — frozen first-seen kiosk snapshot, captured on the FIRST
//               non-empty `setIdentity` call. Stays put on later edits.

import { useEffect, useState } from "react";

const FIELDS = ["name", "dob", "complaint"];

let _state = { name: "", dob: "", complaint: "" };
let _original = null;
const _subs = new Set();

function _notify() {
  _subs.forEach((fn) => {
    try { fn(_state); } catch { /* swallow */ }
  });
}

function _hasAnyValue(obj) {
  return FIELDS.some((k) => obj && obj[k]);
}

export function getIdentity() {
  return _state;
}

export function getOriginalIdentity() {
  return _original;
}

export function setIdentity(partial) {
  // Kiosk-source update (from WS `identity_update` events). Seeds _original
  // on the first call that carries any real values.
  if (!partial) return;
  let changed = false;
  const next = { ..._state };
  for (const k of FIELDS) {
    if (k in partial && partial[k] !== _state[k]) {
      next[k] = partial[k];
      changed = true;
    }
  }
  if (!changed) return;
  if (_original === null && _hasAnyValue(next)) {
    _original = { ...next };
  }
  _state = next;
  _notify();
}

export function editIdentity(next) {
  // Clinician correction. Captures the pre-edit state as `_original` if no
  // kiosk seed exists yet (e.g. clinician opens a session and edits before
  // the kiosk has fired any identity events — unlikely but defensive).
  if (!next) return;
  if (_original === null) {
    _original = { ..._state };
  }
  const merged = { ..._state };
  for (const k of FIELDS) {
    if (k in next) merged[k] = next[k];
  }
  _state = merged;
  _notify();
}

export function clearIdentity() {
  _state = { name: "", dob: "", complaint: "" };
  _original = null;
  _notify();
}

export function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

// React hook — components re-render whenever the store changes.
export function useIdentity() {
  const [s, setS] = useState(_state);
  useEffect(() => subscribe(setS), []);
  return s;
}

// Original kiosk snapshot. Re-renders on the same notify channel as
// useIdentity so a single subscription covers both reads.
export function useOriginalIdentity() {
  const [, setS] = useState(_state);
  useEffect(() => subscribe(setS), []);
  return _original;
}
