/**
 * useWebSocket — minimal WebSocket connection manager.
 *
 * Returns { status, lastEvent, send, sendBinary } and reconnects with backoff.
 */
import { useEffect, useRef, useState, useCallback } from "react";

export function useWebSocket(url, { onEvent } = {}) {
  const [status, setStatus] = useState("idle"); // idle|connecting|open|closed|error
  const [lastEvent, setLastEvent] = useState(null);
  const wsRef = useRef(null);
  const retryRef = useRef(0);
  const stoppedRef = useRef(false);
  // Stash onEvent in a ref so the WebSocket doesn't tear down + reconnect on
  // every parent re-render where onEvent is a fresh closure. Without this,
  // `connect` is rebuilt every render → useEffect cleanup runs → ws_v1.close()
  // is queued (async) while a new ws_v2 is opened immediately. When ws_v1's
  // delayed onclose finally fires it observes stoppedRef=false (the new
  // effect already reset it) and schedules a phantom reconnect, spawning a
  // ws_v3 that co-subscribes to the same room. The backend's bus.publish
  // then delivers each event to multiple sockets → onEvent runs N times →
  // playTTS fires N times with the same text → audio echo on follow-ups.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (!url) return;
    setStatus("connecting");
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setStatus("error");
      return;
    }
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      retryRef.current = 0;
      setStatus("open");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // server → client text only
      try {
        const evt = JSON.parse(ev.data);
        setLastEvent(evt);
        const handler = onEventRef.current;
        handler && handler(evt);
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => setStatus("error");
    ws.onclose = () => {
      // If a newer ws has already taken over (wsRef updated to a different
      // socket), this is a stale close from a torn-down connection — don't
      // drive reconnect logic from here, the active socket owns it.
      if (wsRef.current !== ws) return;
      setStatus("closed");
      if (stoppedRef.current) return;
      const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
      retryRef.current += 1;
      setTimeout(connect, delay);
    };
  }, [url]);

  useEffect(() => {
    stoppedRef.current = false;
    connect();
    return () => {
      stoppedRef.current = true;
      wsRef.current && wsRef.current.close();
    };
  }, [connect]);

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
    return true;
  }, []);

  const sendBinary = useCallback((buf) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(buf);
    return true;
  }, []);

  return { status, lastEvent, send, sendBinary };
}
