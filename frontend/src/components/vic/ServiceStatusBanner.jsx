import { useState, useEffect } from "react";

const HTTP_BASE = import.meta.env.VITE_BACKEND_HTTP_URL || "http://localhost:8000";

export default function ServiceStatusBanner() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`${HTTP_BASE}/health/services`);
        if (!cancelled) setStatus(await res.json());
      } catch {
        if (!cancelled) setStatus({ mode: "offline" });
      }
    };
    check();
    const interval = setInterval(check, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (!status) return null;
  if (status.mode === "ai-assisted") return null;

  const isOffline = status.mode === "offline";
  const isDeterministic = status.mode === "deterministic-fallback";

  const bg = isOffline ? "rgba(255, 100, 80, 0.12)" : "rgba(255, 185, 95, 0.12)";
  const border = isOffline ? "rgba(255, 100, 80, 0.3)" : "rgba(255, 185, 95, 0.3)";
  const color = isOffline ? "#ff6450" : "#ffb95f";
  const message = isOffline
    ? "AI Assist: Offline — backend unreachable"
    : "AI Assist: Offline — deterministic mode";
  const detail = isDeterministic
    ? "All agents using rule-based fallbacks. Triage continues without LLM."
    : "Cannot reach the backend. Check Railway deployment.";

  return (
    <div style={{
      padding: "8px 16px",
      background: bg,
      border: `1px solid ${border}`,
      borderRadius: 8,
      display: "flex",
      alignItems: "center",
      gap: 12,
      marginBottom: 12,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%",
        background: color, flexShrink: 0,
        animation: "ping 2s infinite",
      }} />
      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: 12, fontWeight: 700, color,
          textTransform: "uppercase", letterSpacing: "0.1em",
        }}>
          {message}
        </div>
        <div style={{ fontSize: 11, color: "var(--vic-on-surface-variant)", marginTop: 2 }}>
          {detail}
        </div>
      </div>
      {isDeterministic && !status.thymia?.available && (
        <span style={{
          fontSize: 10, color: "var(--vic-on-surface-variant)",
          padding: "2px 8px", borderRadius: 4,
          background: "rgba(255, 255, 255, 0.05)",
        }}>
          Biomarkers unavailable
        </span>
      )}
    </div>
  );
}
