import { useState, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useWebSocket } from "../hooks/useWebSocket.js";
import TopNav from "../components/vic/TopNav.jsx";
import SideQueue from "../components/vic/SideQueue.jsx";
import OverrideBanner from "../components/vic/OverrideBanner.jsx";
import SOAPCard from "../components/vic/SOAPCard.jsx";
import SwarmPanel from "../components/vic/SwarmPanel.jsx";
import { DEMO_EVENTS, DEMO_PATIENT } from "../components/epic/demoEvents.js";
import { useIdentity, setIdentity as setStoreIdentity } from "../state/identityStore.js";

const WS_BASE = import.meta.env.VITE_BACKEND_WS_URL || "ws://localhost:8000";

const DEFAULT_DEMOGRAPHICS = {
  demo: "Filipino / Male / 59",
  symptom: "Exertion Fatigue",
  risk: "High CVD Risk Profile",
};

export default function ClinicianDashboard() {
  const navigate = useNavigate();
  const [activeRoom, setActiveRoom] = useState("demo");
  const [transcript, setTranscript] = useState("");
  const [biomarkers, setBiomarkers] = useState(null);
  const [flag, setFlag] = useState(null);
  const [soap, setSoap] = useState(null);
  const [esi, setEsi] = useState(null);
  // Identity comes from the in-memory store so navigating between views keeps it.
  const identity = useIdentity();
  const [agentActivity, setAgentActivity] = useState({});
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const timersRef = useRef([]);

  const activeAgents = useMemo(() => {
    return new Set(
      Object.entries(agentActivity)
        .filter(([, v]) => v?.status === "active")
        .map(([k]) => k)
    );
  }, [agentActivity]);

  const processEvent = useCallback((type, data, ts) => {
    if (type === "transcript") {
      setTranscript(data.text);
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-on-surface-variant)", tsColor: "var(--vic-primary)",
        text: `DEEPGRAM: "${data.text}"`,
      }]);
    } else if (type === "biomarker") {
      setBiomarkers(data);
      const h = data?.helios || {};
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-secondary)",
        text: `THYMIA Helios: stress ${(h.stress ?? 0).toFixed(2)} · distress ${(h.distress ?? 0).toFixed(2)} · mental strain ${(h.mentalStrain ?? 0).toFixed(2)}`,
      }]);
    } else if (type === "concordance_flag") {
      setFlag({
        agent: "M.E.R.C.E.D.",
        message: `Patient verbalizes "${data.trigger_phrase}" while voice biomarkers show ${data.signal_summary || "elevated stress"}. ${data.evidence_basis || "MIMIC-IV evidence base supports atypical presentation."}`,
        confidence: data.confidence ? `${(data.confidence * 100).toFixed(1)}%` : "94.2%",
      });
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-tertiary)",
        text: `M.E.R.C.E.D.: tier ${data.tier} flag · trigger: "${data.trigger_phrase}"`,
      }]);
    } else if (type === "soap_update") {
      setSoap({ ...data, ready: true });
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "#67e8f9",
        text: "S.C.R.I.B.E.: SOAP note draft updated",
      }]);
    } else if (type === "esi_update") {
      setEsi(data);
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-primary)",
        text: `V.I.C.T.O.R.: ESI ${data.standard_esi} → ${data.victor_esi} (${data.reason || "concordance signal"})`,
      }]);
    } else if (type === "agent_activity") {
      setAgentActivity(prev => ({ ...prev, [data.agent]: data }));
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-on-surface-variant)",
        text: `${data.agent}: ${data.action}`,
      }]);
    } else if (type === "identity_update") {
      setStoreIdentity(data);
      const fields = Object.keys(data || {}).join(", ");
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-primary)",
        text: `INTAKE: identity captured (${fields})`,
      }]);
    }
  }, []);

  const onEvent = useCallback((evt) => {
    processEvent(evt.type, evt.data);
  }, [processEvent]);

  useWebSocket(`${WS_BASE}/ws/events?room=${activeRoom}`, { onEvent });

  const runDemo = () => {
    setTranscript("");
    setBiomarkers(null);
    setFlag(null);
    setSoap(null);
    setEsi(null);
    setAgentActivity({});
    setLogs([]);
    setRunning(true);
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    const t0 = Date.now();
    DEMO_EVENTS.forEach(({ delay, type, data }) => {
      const id = setTimeout(() => {
        const ts = ((Date.now() - t0) / 1000).toFixed(2) + "s";
        processEvent(type, data, ts);
      }, delay);
      timersRef.current.push(id);
    });
    timersRef.current.push(setTimeout(() => setRunning(false), 3200));
  };

  return (
    <div style={{
      minHeight: "100vh", background: "var(--vic-bg)",
      color: "var(--vic-on-surface)",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <TopNav activeTab="Patient Queue" urgentOverride={!!flag} />
      <SideQueue activeId={activeRoom === "demo" ? "macaraeg" : activeRoom} onSelect={setActiveRoom} />

      <main style={{
        marginLeft: 320, paddingTop: 80, minHeight: "100vh",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{
          padding: 24, display: "grid",
          gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
          gap: 24, alignItems: "start",
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <OverrideBanner flag={flag} />

            <IdentityCard identity={identity} />

            <BiomarkerCard data={biomarkers} />

            {transcript && (
              <section className="vic-glass" style={{
                padding: 20, borderRadius: 16,
                border: "1px solid rgba(47, 217, 244, 0.15)",
              }}>
                <div style={{
                  fontSize: 10, fontWeight: 700,
                  color: "rgba(47, 217, 244, 0.7)",
                  textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 8,
                }}>
                  Live Patient Transcript · Deepgram
                </div>
                <p style={{
                  margin: 0, fontSize: 16, lineHeight: 1.6,
                  color: "var(--vic-on-surface)",
                }}>"{transcript}"</p>
              </section>
            )}

            <SOAPCard soap={soap} demographics={DEFAULT_DEMOGRAPHICS} />

            <ActionFooter
              hasSoap={!!soap}
              onApprove={() => navigate("/clinician/epic")}
              onRunDemo={runDemo}
              running={running}
            />
          </div>

          <div style={{ position: "sticky", top: 96, height: "calc(100vh - 120px)" }}>
            <SwarmPanel
              activeAgents={activeAgents}
              processLoad={running ? 87 : (activeAgents.size * 16)}
              log={logs}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

function ActionFooter({ hasSoap, onApprove, onRunDemo, running }) {
  return (
    <footer style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      paddingTop: 16, borderTop: "1px solid rgba(69, 70, 77, 0.2)",
      flexWrap: "wrap", gap: 16,
    }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button style={ghostBtn}>✎ Edit Note</button>
        <button style={{ ...ghostBtn, color: "var(--vic-error)", borderColor: "rgba(255, 180, 171, 0.25)" }}>
          ⌄ Downgrade to Routine
        </button>
        <button onClick={onRunDemo} disabled={running} style={{ ...ghostBtn, opacity: running ? 0.5 : 1 }}>
          {running ? "Running…" : "▶ Run Demo"}
        </button>
      </div>
      <button
        onClick={onApprove}
        disabled={!hasSoap}
        style={{
          padding: "14px 28px", borderRadius: 12, border: "none",
          background: hasSoap
            ? "linear-gradient(to right, var(--vic-primary), #008ea1)"
            : "var(--vic-bg-highest)",
          color: hasSoap ? "var(--vic-on-primary)" : "var(--vic-on-surface-variant)",
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 700, fontSize: 15, cursor: hasSoap ? "pointer" : "not-allowed",
          letterSpacing: "-0.01em",
          boxShadow: hasSoap ? "0 10px 30px rgba(47, 217, 244, 0.3)" : "none",
          display: "flex", alignItems: "center", gap: 10,
        }}
      >
        ☁ Approve &amp; Push to Epic (EHR)
      </button>
    </footer>
  );
}

// Friendly clinical labels for the dashboard. The API field names + WS
// event payload + concordance engine all stay canonical (mentalStrain,
// exhaustion, sleepPropensity, lowSelfEsteem) — only this card's labels
// are aliased. If thymia ever renames a field, only this dict changes.
const HELIOS_DISPLAY = [
  { key: "mentalStrain",    label: "Mental Strain",         concerningWhen: "high" },
  { key: "stress",          label: "Stress",                concerningWhen: "high" },
  { key: "distress",        label: "Distress",              concerningWhen: "high" },
  { key: "exhaustion",      label: "Burnout / Exhaustion",  concerningWhen: "high" },
  { key: "sleepPropensity", label: "Fatigue",               concerningWhen: "high" },
  // Inverted: API gives `lowSelfEsteem`, dashboard shows `Confidence`.
  // High raw value (low self-esteem) → low confidence display.
  {
    key: "lowSelfEsteem",
    label: "Confidence",
    transform: (v) => 1 - v,
    concerningWhen: "low",
  },
];

function BiomarkerCard({ data }) {
  const h = data?.helios || {};
  const hasAny = HELIOS_DISPLAY.some((f) => typeof h[f.key] === "number");
  return (
    <section className="vic-glass" style={{
      padding: 20, borderRadius: 16,
      border: "1px solid rgba(47, 217, 244, 0.15)",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700,
        color: "rgba(47, 217, 244, 0.8)",
        textTransform: "uppercase", letterSpacing: "0.2em",
      }}>
        Voice Biomarkers · thymia Helios
      </div>
      {!hasAny ? (
        <div style={{
          fontSize: 13, fontStyle: "italic",
          color: "var(--vic-on-surface-variant)",
        }}>
          Awaiting voice sample…
        </div>
      ) : (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 14,
        }}>
          {HELIOS_DISPLAY.map((f) => {
            const raw = typeof h[f.key] === "number" ? h[f.key] : 0;
            const display = f.transform ? f.transform(raw) : raw;
            // Concordance thresholds the backend uses: stress/distress/
            // mentalStrain ≥0.66, exhaustion ≥0.33. Keep the dashboard
            // "concerning" indicator aligned with those.
            const concernCutoffHigh = f.key === "exhaustion" ? 0.33 : 0.66;
            const concerning = f.concerningWhen === "high"
              ? display >= concernCutoffHigh
              : display <= 0.34;
            return (
              <BiomarkerBar
                key={f.key}
                label={f.label}
                value={display}
                concerning={concerning}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function BiomarkerBar({ label, value, concerning }) {
  const v = typeof value === "number" ? value : 0;
  const pct = Math.round(v * 100);
  return (
    <div>
      <div style={{
        display: "flex", justifyContent: "space-between",
        marginBottom: 4,
      }}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10, fontWeight: 700,
          color: "var(--vic-on-surface-variant)",
          textTransform: "uppercase", letterSpacing: "0.16em",
        }}>{label}</span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
          color: concerning ? "var(--vic-error)" : "var(--vic-on-surface)",
          fontWeight: 700,
        }}>
          {v.toFixed(2)}{concerning ? " ⚠" : ""}
        </span>
      </div>
      <div style={{
        height: 6, background: "rgba(255,255,255,0.06)",
        borderRadius: 999, overflow: "hidden",
      }}>
        <div style={{
          height: "100%", width: `${pct}%`,
          background: concerning
            ? "linear-gradient(to right, #ffb46f, var(--vic-error))"
            : "linear-gradient(to right, var(--vic-primary), #67e8f9)",
          transition: "width 0.4s ease",
        }} />
      </div>
    </div>
  );
}

function IdentityCard({ identity }) {
  const { name, dob, complaint } = identity || {};
  if (!name && !dob && !complaint) return null;
  return (
    <section className="vic-glass" style={{
      padding: 20, borderRadius: 16,
      border: "1px solid rgba(47, 217, 244, 0.25)",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700,
        color: "rgba(47, 217, 244, 0.8)",
        textTransform: "uppercase", letterSpacing: "0.2em",
      }}>
        Patient Intake · Captured at Kiosk
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 16,
      }}>
        <IdField label="Name" value={name || "—"} primary={!!name} />
        <IdField label="Date of birth" value={dob || "—"} primary={!!dob} />
        <IdField
          label="Reason for visit"
          value={complaint || "—"}
          primary={!!complaint}
          wide
        />
      </div>
    </section>
  );
}

function IdField({ label, value, primary, wide }) {
  return (
    <div style={{ gridColumn: wide ? "1 / -1" : "auto" }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10, fontWeight: 700,
        color: "var(--vic-on-surface-variant)",
        textTransform: "uppercase", letterSpacing: "0.18em",
        marginBottom: 4,
      }}>{label}</div>
      <div style={{
        fontSize: 16, lineHeight: 1.4,
        color: primary ? "var(--vic-on-surface)" : "var(--vic-on-surface-variant)",
        fontWeight: primary ? 600 : 400,
      }}>{value}</div>
    </div>
  );
}

const ghostBtn = {
  padding: "10px 18px", borderRadius: 10,
  background: "var(--vic-bg-highest)", color: "var(--vic-on-surface)",
  border: "1px solid rgba(69, 70, 77, 0.4)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600, fontSize: 13, cursor: "pointer",
  display: "flex", alignItems: "center", gap: 8,
};
