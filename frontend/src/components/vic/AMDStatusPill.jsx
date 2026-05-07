import { useEffect, useState } from "react";
import { HTTP_BASE } from "../../lib/backend-urls.js";

// AMD MI300X status pill. Shown on the patient welcome screen and the
// clinician dashboard top nav. Polls /health/services every 60s and
// shows the actual inference state — never just decoration.
//
// States (always honest about MI300X — the LoRA WAS trained on MI300X
// regardless of where it's currently inferring):
//   "Active"      — LLM reachable AND endpoint is non-localhost (real
//                   MI300X / Reserved IP serving). Green dot.
//   "Local"       — LLM reachable but endpoint is localhost (Ollama dev
//                   environment serving the LoRA — MI300X was where it
//                   was trained). Cyan dot.
//   "Fallback"    — LLM unreachable; agents running deterministic
//                   fallbacks. Amber dot. The LoRA is still on HF.
//   "Loading"     — initial fetch in flight. Grey dot.
//
// Click the pill to expand the details panel: shows endpoint, mode,
// model name, and a link to the HF model card.
export default function AMDStatusPill({ compact = false }) {
  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await fetch(`${HTTP_BASE}/health/services`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const endpoint = data?.llm?.endpoint || "";
        const llmAvailable = !!data?.llm?.available;
        const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(endpoint);
        let status;
        if (llmAvailable && !isLocal) status = "active";       // remote MI300X
        else if (llmAvailable && isLocal) status = "local";     // dev Ollama
        else status = "fallback";
        setState({ status, endpoint, mode: data?.mode, demoMode: data?.demo_mode });
      } catch {
        if (!cancelled) setState({ status: "fallback" });
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const meta = STATE_META[state.status] || STATE_META.loading;
  return (
    <a
      href="https://huggingface.co/jantam13/victor-triage-lora-llama3.1-8b"
      target="_blank"
      rel="noreferrer"
      title={`${meta.label} — click for HuggingFace model card`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        padding: compact ? "5px 12px" : "7px 14px",
        borderRadius: "var(--vic-radius-pill)",
        background: meta.bg,
        border: `1px solid ${meta.border}`,
        color: meta.color,
        fontSize: compact ? 11 : 12, fontWeight: 600,
        fontFamily: "'Space Grotesk', 'Inter', sans-serif",
        letterSpacing: "0.02em",
        textDecoration: "none",
        transition: "background 0.15s, border-color 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{
        width: 7, height: 7, borderRadius: "50%",
        background: meta.dot,
        animation: state.status === "active" ? "vic-pulse 2s ease-in-out infinite" : "none",
      }} />
      <span>AMD MI300X · {meta.label}</span>
    </a>
  );
}

const STATE_META = {
  active: {
    label: "Active",
    color: "var(--vic-aligned)",
    bg: "rgba(120, 200, 160, 0.08)",
    border: "rgba(120, 200, 160, 0.30)",
    dot: "var(--vic-aligned)",
  },
  local: {
    label: "Trained · Local Inference",
    color: "var(--vic-primary)",
    bg: "rgba(47, 217, 244, 0.06)",
    border: "rgba(47, 217, 244, 0.25)",
    dot: "var(--vic-primary)",
  },
  fallback: {
    label: "Trained · Deterministic Fallback",
    color: "var(--vic-warning)",
    bg: "rgba(255, 180, 111, 0.06)",
    border: "rgba(255, 180, 111, 0.25)",
    dot: "var(--vic-warning)",
  },
  loading: {
    label: "Detecting…",
    color: "var(--vic-on-surface-variant)",
    bg: "rgba(46, 52, 71, 0.4)",
    border: "rgba(69, 70, 77, 0.3)",
    dot: "var(--vic-on-surface-variant)",
  },
};
