/**
 * useEventBus — tiny in-page pub/sub.
 *
 * Used to coordinate components on the clinician dashboard that all read from
 * the same WebSocket event stream. Day 2 — replace with the real EventBus
 * when the backend pub/sub goes live.
 */
import { useEffect, useRef } from "react";

const subs = new Map();

export function publish(topic, payload) {
  const set = subs.get(topic);
  if (!set) return;
  set.forEach((cb) => {
    try {
      cb(payload);
    } catch (e) {
      console.error("eventbus subscriber threw", e);
    }
  });
}

export function useEventBus(topic, handler) {
  const cb = useRef(handler);
  cb.current = handler;
  useEffect(() => {
    const wrap = (p) => cb.current && cb.current(p);
    if (!subs.has(topic)) subs.set(topic, new Set());
    subs.get(topic).add(wrap);
    return () => subs.get(topic)?.delete(wrap);
  }, [topic]);
}
