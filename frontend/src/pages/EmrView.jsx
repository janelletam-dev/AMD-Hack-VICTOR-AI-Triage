import { useState, useCallback, useRef, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useWebSocket } from "../hooks/useWebSocket.js";
import TopNav from "../components/vic/TopNav.jsx";
import {
  EpicPatientBanner,
  EpicTabs,
  EpicToolbar,
  EpicRail,
  EpicStatusBar,
} from "../components/epic/EpicChrome.jsx";
import {
  EpicConcordanceSection,
  EpicESISection,
  EpicBiomarkersSection,
  EpicTranscriptSection,
  EpicSOAPSection,
} from "../components/epic/EpicClinicalSections.jsx";
import { DEMO_EVENTS, DEMO_PATIENT } from "../components/epic/demoEvents.js";
import { useIdentity, setIdentity as setStoreIdentity } from "../state/identityStore.js";
import {
  appendTranscript as logTranscript,
  setBiomarkerSummary as logBiomarkers,
  appendFlag as logFlag,
  setSOAP as logSOAP,
  setESI as logESI,
  setIdentity as logIdentity,
  setEmergency as logEmergency,
  setTriageComplete as logTriageComplete,
} from "../state/sessionLogStore.js";

import { HTTP_BASE, WS_BASE } from "../lib/backend-urls.js";

function ageFromDOB(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

function mergedPatient(base, identity) {
  if (!identity) return base;
  const { name, dob, gender, complaint } = identity;
  const merged = { ...base };
  if (name) merged.name = name.toUpperCase();
  if (dob) {
    merged.dob = dob;
    const a = ageFromDOB(dob);
    if (a != null) merged.age = a;
  }
  // EpicPatientBanner reads `patient.sex`; the kiosk captures `gender`.
  // Epic's banner historically shows binary sex, but we honour the
  // patient's actual selection here ("Female" / "Male" / "Non-binary" /
  // "Prefer not to say") — chart accuracy beats UI compactness.
  if (gender) merged.sex = gender;
  if (complaint) merged.cc = complaint;
  return merged;
}

export default function EmrView() {
  const navigate = useNavigate();
  const location = useLocation();
  const [activeRoom] = useState("demo");
  // Push receipt — populated either from navigation state (immediate path
  // after the dashboard Approve button) or fetched from /api/epic/receipt
  // on mount (so a deep link / hard refresh still shows the banner).
  const [pushReceipt, setPushReceipt] = useState(location.state?.pushReceipt || null);
  useEffect(() => {
    if (pushReceipt) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${HTTP_BASE}/api/epic/receipt/${activeRoom}`);
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled && data?.pushed) setPushReceipt(data);
      } catch { /* network blip — banner stays hidden */ }
    })();
    return () => { cancelled = true; };
  }, [activeRoom, pushReceipt]);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("vic-emr-theme") || "dark"
  );
  useEffect(() => { localStorage.setItem("vic-emr-theme", theme); }, [theme]);
  const isDark = theme === "dark";
  const [transcriptLines, setTranscriptLines] = useState([]);
  const [biomarkers, setBiomarkers] = useState(null);
  const [flag, setFlag] = useState(null);
  const [soap, setSoap] = useState(null);
  const [esi, setEsi] = useState(null);
  const identity = useIdentity();
  const [running, setRunning] = useState(false);
  const timersRef = useRef([]);

  const processEvent = useCallback((type, data) => {
    if (type === "transcript") {
      setTranscriptLines(prev => [...prev.slice(-49), data]);
      logTranscript(data);
    } else if (type === "biomarker") {
      setBiomarkers(data);
      logBiomarkers(data);
    } else if (type === "concordance_flag") {
      setFlag(data);
      logFlag(data);
    } else if (type === "soap_update") {
      setSoap(data);
      logSOAP(data);
    } else if (type === "esi_update") {
      setEsi(data);
      logESI(data);
    } else if (type === "identity_update") {
      setStoreIdentity(data);
      logIdentity(data);
    } else if (type === "triage_complete") {
      logTriageComplete(true);
    } else if (type === "triage_emergency") {
      logEmergency(data);
    }
  }, []);

  const onEvent = useCallback((evt) => processEvent(evt.type, evt.data), [processEvent]);
  useWebSocket(`${WS_BASE}/ws/events?room=${activeRoom}`, { onEvent });

  const runDemo = () => {
    setTranscriptLines([]); setBiomarkers(null); setFlag(null); setSoap(null); setEsi(null);
    setRunning(true);
    timersRef.current.forEach(clearTimeout);
    timersRef.current = DEMO_EVENTS.map(({ delay, type, data }) =>
      setTimeout(() => processEvent(type, data), delay)
    );
    timersRef.current.push(setTimeout(() => setRunning(false), 3200));
  };

  return (
    <div
      className={isDark ? "vic-emr" : ""}
      style={{
        minHeight: "100vh", display: "flex", flexDirection: "column",
        background: isDark ? "var(--vic-bg)" : "#cdd9e6",
      }}
    >
      {isDark && <TopNav activeTab="Dashboard" urgentOverride={!!flag} />}
      <ThemeToggle theme={theme} onChange={setTheme} dark={isDark} />

      <div className="epic-root" style={{
        flex: 1, display: "flex", flexDirection: "column",
        marginTop: isDark ? 80 : 0,
        minHeight: isDark ? "calc(100vh - 80px)" : "100vh",
      }}>
        {!isDark && <LightTitleBar />}
        {pushReceipt && (
          <PostedToEpicBanner receipt={pushReceipt} room={activeRoom} dark={isDark} />
        )}
        <EpicPatientBanner patient={mergedPatient(DEMO_PATIENT, identity)} esi={esi} />
        <EpicTabs />
        <EpicToolbar onRunDemo={runDemo} running={running} />

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <EpicRail />
          <div style={{ flex: 1, padding: 6, overflow: "auto", minWidth: 0 }}>
            <EpicConcordanceSection flag={flag} />
            <EpicESISection esi={esi} />
            <EpicBiomarkersSection data={biomarkers} />
            <EpicTranscriptSection lines={transcriptLines} />
            <EpicSOAPSection note={soap} />

            <div style={{
              display: "flex", gap: 8, justifyContent: "space-between",
              alignItems: "center", padding: "12px 4px",
            }}>
              <button className="epic-btn" onClick={() => navigate("/clinician")}>
                ← Back to Triage Workspace
              </button>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  className="epic-btn"
                  disabled
                  title="V2 — not yet wired. The note can be edited from the live triage workspace via the Edit Note button."
                  style={{ opacity: 0.5, cursor: "not-allowed" }}
                >
                  Edit
                </button>
                <button
                  className="epic-btn"
                  disabled
                  title="V2 — not yet wired. RN escalation/reassignment workflow is on the V2 roadmap."
                  style={{ opacity: 0.5, cursor: "not-allowed" }}
                >
                  Defer to RN
                </button>
                <button
                  className="epic-btn primary"
                  onClick={() => navigate("/clinician/report")}
                >
                  Sign &amp; Save → Generate Report
                </button>
              </div>
            </div>
          </div>
        </div>

        <EpicStatusBar />
      </div>
    </div>
  );
}

function ThemeToggle({ theme, onChange, dark }) {
  return (
    <div style={{
      position: "fixed", top: dark ? 96 : 4, right: 24, zIndex: 60,
      display: "flex", gap: 2, padding: 3, borderRadius: 999,
      background: dark ? "rgba(46, 52, 71, 0.92)" : "rgba(255, 255, 255, 0.95)",
      border: `1px solid ${dark ? "rgba(47, 217, 244, 0.35)" : "#95acc7"}`,
      boxShadow: dark ? "0 4px 12px rgba(0,0,0,0.4)" : "0 2px 6px rgba(15, 26, 42, 0.15)",
      backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
    }}>
      <ThemeBtn active={theme === "dark"}  onClick={() => onChange("dark")}  dark={dark} label="Dark"  icon="◗" />
      <ThemeBtn active={theme === "light"} onClick={() => onChange("light")} dark={dark} label="Light" icon="☀" />
    </div>
  );
}

function ThemeBtn({ active, onClick, dark, label, icon }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "5px 12px", borderRadius: 999, border: "none",
        background: active
          ? (dark ? "var(--vic-primary)" : "#2c5e9e")
          : "transparent",
        color: active
          ? (dark ? "var(--vic-on-primary)" : "#ffffff")
          : (dark ? "var(--vic-on-surface-variant)" : "#1a2332"),
        fontSize: 11, fontWeight: 700,
        fontFamily: "'JetBrains Mono', monospace",
        textTransform: "uppercase", letterSpacing: "0.1em",
        cursor: "pointer",
      }}
    >
      <span style={{ fontSize: 12 }}>{icon}</span>{label}
    </button>
  );
}

// Banner shown above the chart once the dashboard's "Approve & Push to
// Epic" has succeeded. Reads the doc_id + posted_at from the push
// receipt and offers a one-click download of the underlying FHIR
// bundle so a clinician auditor can inspect what was actually sent.
function PostedToEpicBanner({ receipt, room, dark }) {
  const posted = receipt?.posted_at
    ? new Date(receipt.posted_at * 1000).toLocaleString()
    : "—";
  const docId = receipt?.doc_id || "—";
  const summary = receipt?.summary || {};
  const bundleUrl = `${HTTP_BASE}/api/epic/bundle/${room}`;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
      padding: "10px 16px",
      background: dark ? "rgba(47, 217, 244, 0.08)" : "#dff5f7",
      borderBottom: `1px solid ${dark ? "rgba(47, 217, 244, 0.30)" : "#9ad4dd"}`,
      color: dark ? "var(--vic-on-surface)" : "#0e3e44",
      fontSize: 13,
    }}>
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        fontWeight: 700, letterSpacing: "0.04em",
      }}>
        <span style={{ fontSize: 14 }}>☁</span>
        Posted to Epic
      </span>
      <span style={{ opacity: 0.8 }}>{posted}</span>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
        padding: "3px 8px", borderRadius: 4,
        background: dark ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.7)",
        border: `1px solid ${dark ? "rgba(47, 217, 244, 0.20)" : "#9ad4dd"}`,
      }}>
        Doc ID · {docId}
      </span>
      {summary.esi_adjusted && (
        <span style={{ opacity: 0.85 }}>
          ESI {summary.esi_adjusted}
          {summary.esi_standard && summary.esi_adjusted < summary.esi_standard
            ? ` (escalated from ${summary.esi_standard})` : ""}
        </span>
      )}
      {typeof summary.flags === "number" && summary.flags > 0 && (
        <span style={{ opacity: 0.85 }}>{summary.flags} concordance flag{summary.flags === 1 ? "" : "s"}</span>
      )}
      <a
        href={bundleUrl}
        target="_blank"
        rel="noreferrer"
        style={{
          marginLeft: "auto",
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
          textTransform: "uppercase", letterSpacing: "0.12em",
          color: dark ? "var(--vic-primary)" : "#0e7c86",
          textDecoration: "none",
          padding: "5px 10px", borderRadius: 4,
          border: `1px solid ${dark ? "rgba(47, 217, 244, 0.35)" : "#9ad4dd"}`,
        }}
      >
        ↓ FHIR bundle
      </a>
    </div>
  );
}

function LightTitleBar() {
  return (
    <div className="epic-titlebar">
      <span style={{ fontWeight: 600 }}>V.I.C.T.O.R.</span>
      <span className="lozenge">Triage Workspace</span>
      <span style={{ marginLeft: "auto" }}>Mercy Hospital Springfield · ED Track 2</span>
      <span>Dr. Reyes, A.</span>
      <span>Print</span>
      <span>Secure</span>
      <span>Log Out</span>
    </div>
  );
}
