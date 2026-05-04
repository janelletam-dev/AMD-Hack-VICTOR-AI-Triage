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
        onEvent && onEvent(evt);
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => setStatus("error");
    ws.onclose = () => {
      setStatus("closed");
      if (stoppedRef.current) return;
      const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
      retryRef.current += 1;
      setTimeout(connect, delay);
    };
  }, [url, onEvent]);

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
