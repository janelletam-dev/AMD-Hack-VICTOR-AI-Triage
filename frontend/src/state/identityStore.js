// In-memory identity store, shared across patient / clinician / EMR views.
// Lives for the lifetime of the page — a hard refresh clears it.

import { useEffect, useState } from "react";

let _state = { name: "", dob: "", complaint: "" };
const _subs = new Set();

export function getIdentity() {
  return _state;
}

export function setIdentity(partial) {
  if (!partial) return;
  let changed = false;
  const next = { ..._state };
  for (const k of ["name", "dob", "complaint"]) {
    if (k in partial && partial[k] !== _state[k]) {
      next[k] = partial[k];
      changed = true;
    }
  }
  if (!changed) return;
  _state = next;
  _subs.forEach((fn) => {
    try { fn(_state); } catch { /* swallow */ }
  });
}

export function clearIdentity() {
  _state = { name: "", dob: "", complaint: "" };
  _subs.forEach((fn) => { try { fn(_state); } catch { /* swallow */ } });
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
