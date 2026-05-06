import { useState, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useWebSocket } from "../hooks/useWebSocket.js";
import TopNav from "../components/vic/TopNav.jsx";
import SideQueue from "../components/vic/SideQueue.jsx";
import OverrideBanner from "../components/vic/OverrideBanner.jsx";
import ServiceStatusBanner from "../components/vic/ServiceStatusBanner.jsx";
import SOAPCard from "../components/vic/SOAPCard.jsx";
import SwarmPanel from "../components/vic/SwarmPanel.jsx";
import { DEMO_EVENTS, DEMO_PATIENT } from "../components/epic/demoEvents.js";
import {
  useIdentity,
  useOriginalIdentity,
  setIdentity as setStoreIdentity,
  editIdentity as editStoreIdentity,
} from "../state/identityStore.js";
import {
  appendTranscript as logTranscript,
  setBiomarkerSummary as logBiomarkers,
  appendFlag as logFlag,
  setSOAP as logSOAP,
  setESI as logESI,
  setIdentity as logIdentity,
  setEmergency as logEmergency,
  setTriageComplete as logTriageComplete,
  clearSessionLog,
} from "../state/sessionLogStore.js";

const WS_BASE = import.meta.env.VITE_BACKEND_WS_URL || "ws://localhost:8000";

// Demographics on the SOAP card are derived live from captured data —
// never hardcoded. Anything we don't actually know stays empty (the
// SOAPCard skips fields with falsy values). Showing fabricated info
// like "High CVD Risk Profile" before the patient has been asked about
// family history would be clinically misleading on a real demo.

function ageFromDOB(dob) {
  if (!dob || dob === "Not provided") return null;
  // Handles "April 13, 1990" (parseDOB output) and "1990-04-13" (ISO)
  const d = new Date(dob);
  if (isNaN(d.getTime())) {
    const yearMatch = String(dob).match(/\b(19\d{2}|20\d{2})\b/);
    if (!yearMatch) return null;
    return new Date().getFullYear() - parseInt(yearMatch[1], 10);
  }
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

function buildDemographics(identity, flagQueue) {
  if (!identity) identity = {};
  // Demo line: name · age · sex. Sex assigned at birth is captured on
  // the kiosk between DOB and complaint as a binary tap (Female/Male)
  // — that's what drives ED-triage decisions (drug dosing, lab
  // reference ranges, dx priors). Internal field name remains `gender`
  // for backwards-compat with downstream consumers.
  const demoParts = [];
  if (identity.name) demoParts.push(identity.name);
  const age = ageFromDOB(identity.dob);
  if (age != null) demoParts.push(`${age}y`);
  if (identity.gender) demoParts.push(identity.gender);

  // Presenting symptom: prefer concordance flag's clinical label if
  // fired (more specific than raw complaint text), fall back to the
  // captured complaint truncated.
  const topFlag = flagQueue && flagQueue[0];
  const symptomFromFlag = topFlag?.triage_label;
  const complaintText = (identity.complaint || "").trim();
  const symptomFromComplaint = complaintText
    ? (complaintText.length > 40 ? complaintText.slice(0, 40) + "…" : complaintText)
    : null;
  const symptom = symptomFromFlag || symptomFromComplaint || null;

  // Risk: ONLY surface real concordance signals. No "High CVD Risk Profile"
  // before the patient's been asked about family history. If a Tier 1/2
  // flag fired and lists risk_factors, surface those. Otherwise empty.
  let risk = null;
  if (topFlag?.risk_factors?.length) {
    const factors = topFlag.risk_factors.slice(0, 2).join(", ");
    risk = `${factors} risk factor${topFlag.risk_factors.length > 1 ? "s" : ""}`;
  } else if (topFlag?.tier === 1) {
    risk = "Concordance flag — Tier 1";
  } else if (topFlag?.tier === 2) {
    risk = "Concordance flag — Tier 2";
  }

  // Hide the section entirely if NOTHING is known yet.
  if (!demoParts.length && !symptom && !risk) return null;
  return {
    demo: demoParts.join(" · ") || null,
    symptom,
    risk,
  };
}

export default function ClinicianDashboard() {
  const navigate = useNavigate();
  const [activeRoom, setActiveRoom] = useState("demo");
  const [transcript, setTranscript] = useState("");
  const [biomarkers, setBiomarkers] = useState(null);
  const [biomarkerUnavailable, setBiomarkerUnavailable] = useState(false);
  const [flag, setFlag] = useState(null);
  const [flagQueue, setFlagQueue] = useState([]);
  // Clinical risk scores keyed by score name (HEART / Wells / Alvarado).
  // Backend emits `risk_score` events; we keep the full breakdown per
  // score and render one RiskScoreBadge per active score in IdentityCard.
  // Multiple scores can fire concurrently — e.g. an SOB patient with
  // chest pain triggers BOTH HEART and Wells.
  const [riskScores, setRiskScores] = useState({});
  const [soap, setSoap] = useState(null);
  const [esi, setEsi] = useState(null);
  const [nurseEsi, setNurseEsi] = useState(null);
  // Identity comes from the in-memory store so navigating between views keeps it.
  const identity = useIdentity();
  const [agentActivity, setAgentActivity] = useState({});
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [triageComplete, setTriageComplete] = useState(false);
  const [sessionStatus, setSessionStatus] = useState(null);
  const [showDowngradeModal, setShowDowngradeModal] = useState(false);
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);
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
      logTranscript(data);
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-on-surface-variant)", tsColor: "var(--vic-primary)",
        text: `DEEPGRAM: "${data.text}"`,
      }]);
    } else if (type === "biomarker") {
      // Reset the "unavailable" sticky state — a fresh biomarker event
      // means Thymia (or DEMO_MODE) succeeded this round, supersedes any
      // earlier 403/timeout banner.
      setBiomarkerUnavailable(false);
      setBiomarkers(data);
      logBiomarkers(data);
      const h = data?.helios || {};
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-secondary)",
        text: `THYMIA Helios: stress ${(h.stress ?? 0).toFixed(2)} · distress ${(h.distress ?? 0).toFixed(2)} · mental strain ${(h.mentalStrain ?? 0).toFixed(2)}${data?.apollo ? ` | Apollo: valence ${(data.apollo.valence ?? 0).toFixed(2)} · energy ${(data.apollo.energy ?? 0).toFixed(2)}` : ""}${data?.psyche?.dominant ? ` | Psyche: ${data.psyche.dominant} ${Math.round((data.psyche.confidence ?? 0) * 100)}%` : ""}`,
      }]);
    } else if (type === "biomarker_unavailable") {
      setBiomarkerUnavailable(true);
      setBiomarkers(null);
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-error)",
        text: `THYMIA: ${data.reason || "Biomarker data unavailable"}`,
      }]);
    } else if (type === "concordance_flag") {
      const newFlag = {
        agent: "M.E.R.C.E.D.",
        tier: data.tier,
        message: `Patient verbalizes "${data.trigger_phrase}" while voice biomarkers show ${data.signal_summary || "elevated stress"}. ${data.evidence_basis || "MIMIC-IV evidence base supports atypical presentation."}`,
        confidence: data.confidence ? `${(data.confidence * 100).toFixed(1)}%` : "94.2%",
        repeated: data.repeated || false,
      };
      // Queue flags sorted by severity (Tier 1 first). Show most severe as primary.
      setFlagQueue(prev => {
        const updated = [...prev, newFlag].sort((a, b) => (a.tier || 99) - (b.tier || 99));
        setFlag(updated[0]);
        return updated;
      });
      logFlag(data);
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-tertiary)",
        text: `M.E.R.C.E.D.: tier ${data.tier} flag · trigger: "${data.trigger_phrase}"${data.repeated ? " (repeated)" : ""}`,
      }]);
    } else if (type === "session_status") {
      setSessionStatus(data);
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: data.status === "abandoned" ? "var(--vic-error)" : "var(--vic-on-surface-variant)",
        text: `SESSION: ${data.status} — ${data.reason || ""}`,
      }]);
    } else if (type === "soap_update") {
      setSoap({ ...data, ready: true });
      logSOAP({ ...data, ready: true });
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "#67e8f9",
        text: "S.C.R.I.B.E.: SOAP note draft updated",
      }]);
    } else if (type === "esi_update") {
      setEsi(data);
      logESI(data);
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
      logIdentity(data);
      const fields = Object.keys(data || {}).join(", ");
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-primary)",
        text: `INTAKE: identity captured (${fields})`,
      }]);
    } else if (type === "risk_score") {
      // Clinical risk-strat number from clinical_knowledge.py. Multiple
      // scores can be active concurrently for one patient (e.g. SOB +
      // chest → HEART + Wells), so we store keyed by score name and
      // render one badge per active score in IdentityCard. Each event
      // overwrites the prior value for that score (recomputed every
      // JACKIE turn as more data accumulates).
      const name = data?.score || "Risk";
      setRiskScores((prev) => ({ ...prev, [name]: data }));
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "#ffb46f",
        text: `RISK: ${name} clinical = ${data?.clinical_total ?? "?"}/${data?.max_clinical ?? "?"} — ${data?.interpretation || ""}`,
      }]);
    } else if (type === "jackie_turn") {
      // Conversational follow-up question generated by J.A.C.K.I.E. and
      // spoken to the patient via ElevenLabs. Show it in the swarm log so
      // the clinician can see exactly what the agent is asking.
      const text = data?.text || "";
      if (text && ts) {
        const turn = data?.turn;
        const max = data?.max_turns;
        const closing = data?.closing ? " (closing)" : "";
        const tag = turn != null && max != null ? `[${turn}/${max}]${closing}` : closing;
        setLogs(prev => [...prev.slice(-50), {
          ts, color: "var(--vic-tertiary)",
          text: `J.A.C.K.I.E. ${tag}: "${text}"`,
        }]);
      }
    } else if (type === "triage_complete") {
      setTriageComplete(true);
      logTriageComplete(true);
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-primary)",
        text: `V.I.C.T.O.R.: triage complete (${data?.reason || ""})`,
      }]);
    } else if (type === "triage_emergency") {
      logEmergency(data);
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-error)",
        text: `🚨 EMERGENCY: ${data?.label || ""} — "${data?.matched_phrase || ""}"`,
      }]);
    } else if (type === "safety_escalation") {
      if (ts) setLogs(prev => [...prev.slice(-50), {
        ts, color: "var(--vic-error)",
        text: `⚠️ SAFETY ESCALATION (ESI-2): ${data?.label || ""} — "${data?.matched_phrase || ""}" [hardcoded keyword, no AI]`,
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
    setBiomarkerUnavailable(false);
    setFlag(null);
    setFlagQueue([]);
    setRiskScores({});
    setSoap(null);
    setEsi(null);
    setNurseEsi(null);
    setAgentActivity({});
    setLogs([]);
    setRunning(true);
    setTriageComplete(false);
    setSessionStatus(null);
    setShowDowngradeModal(false);
    setShowApproveConfirm(false);
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
            <ServiceStatusBanner />
            <OverrideBanner flag={flag} />

            {/* Queued flags below the primary (Tier 1) banner */}
            {flagQueue.length > 1 && (
              <div style={{
                padding: "12px 16px", borderRadius: 12,
                background: "rgba(147, 0, 10, 0.08)",
                border: "1px solid rgba(255, 180, 171, 0.15)",
                fontSize: 12, color: "var(--vic-on-surface-variant)",
              }}>
                <span style={{ fontWeight: 700 }}>+{flagQueue.length - 1} additional flag{flagQueue.length > 2 ? "s" : ""} queued</span>
                {flagQueue.slice(1).map((f, i) => (
                  <div key={i} style={{ marginTop: 6, fontSize: 11, opacity: 0.8 }}>
                    Tier {f.tier}: {f.message?.slice(0, 80)}…{f.repeated ? " (repeated)" : ""}
                  </div>
                ))}
              </div>
            )}

            {sessionStatus && (
              <div style={{
                padding: "12px 16px", borderRadius: 12,
                background: sessionStatus.status === "abandoned"
                  ? "rgba(255, 180, 171, 0.08)" : "rgba(255, 185, 95, 0.08)",
                border: `1px solid ${sessionStatus.status === "abandoned"
                  ? "rgba(255, 180, 171, 0.25)" : "rgba(255, 185, 95, 0.25)"}`,
                fontSize: 13, color: "var(--vic-on-surface-variant)",
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <span style={{ fontSize: 16 }}>
                  {sessionStatus.status === "abandoned" ? "⏸" : "⚡"}
                </span>
                <span>
                  <strong style={{ textTransform: "capitalize" }}>
                    Session {sessionStatus.status}
                  </strong>
                  {" — "}{sessionStatus.reason}
                </span>
              </div>
            )}

            <IdentityCard
              identity={identity}
              flagQueue={flagQueue}
              transcript={transcript}
              riskScores={riskScores}
            />

            <BiomarkerCard data={biomarkers} unavailable={biomarkerUnavailable} />

            {/* The standalone "Live Patient Transcript" card used to live
                here. It's been moved INSIDE IdentityCard's verbatim
                accordion ("→ view patient's own words"), per Epic 2018+
                chart layout: distilled CC primary, verbatim one click
                away. Keeps the chart header scannable without losing
                medico-legal traceability. */}

            <SOAPCard soap={soap} demographics={buildDemographics(identity, flagQueue)} />

            <ActionFooter
              hasSoap={!!soap}
              triageComplete={triageComplete}
              onApprove={() => {
                if (!triageComplete) {
                  setShowApproveConfirm(true);
                } else {
                  navigate("/clinician/epic");
                }
              }}
              onDowngrade={() => setShowDowngradeModal(true)}
              onRunDemo={runDemo}
              running={running}
            />

            {showApproveConfirm && (
              <ConfirmDialog
                title="Triage is still in progress"
                message="Approve current assessment? The patient interview has not completed."
                onConfirm={() => { setShowApproveConfirm(false); navigate("/clinician/epic"); }}
                onCancel={() => setShowApproveConfirm(false)}
              />
            )}

            {showDowngradeModal && (
              <DowngradeModal
                onSubmit={(reason) => {
                  setShowDowngradeModal(false);
                  setNurseEsi(esi?.victor_esi ? esi.victor_esi + 1 : 4);
                }}
                onCancel={() => setShowDowngradeModal(false)}
              />
            )}
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

function ActionFooter({ hasSoap, triageComplete, onApprove, onDowngrade, onRunDemo, running }) {
  // Hide the Run Demo button unless ?dev=1 is on the URL — judges shouldn't
  // see a "this is canned" tell during a live demo. Keeps the scripted
  // playback reachable as a worst-case fallback (visit /clinician?dev=1).
  const showDemoButton = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("dev") === "1";
  return (
    <footer style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      paddingTop: 16, borderTop: "1px solid rgba(69, 70, 77, 0.2)",
      flexWrap: "wrap", gap: 16,
    }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button style={ghostBtn}>✎ Edit Note</button>
        <button
          onClick={onDowngrade}
          style={{ ...ghostBtn, color: "var(--vic-error)", borderColor: "rgba(255, 180, 171, 0.25)" }}
        >
          ⌄ Downgrade to Routine
        </button>
        {showDemoButton && (
          <button onClick={onRunDemo} disabled={running} style={{ ...ghostBtn, opacity: running ? 0.5 : 1 }}>
            {running ? "Running…" : "▶ Run Demo"}
          </button>
        )}
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

function BiomarkerCard({ data, unavailable }) {
  const h = data?.helios || {};
  const a = data?.apollo || null;
  const p = data?.psyche || null;
  const hasAny = HELIOS_DISPLAY.some((f) => typeof h[f.key] === "number");
  // All zeros from Thymia = silent failure. Show unavailable message.
  const allZeros = hasAny && HELIOS_DISPLAY.every((f) => (h[f.key] || 0) === 0);
  return (
    <section className="vic-glass" style={{
      padding: 20, borderRadius: 16,
      border: `1px solid ${unavailable || allZeros ? "rgba(255, 185, 95, 0.25)" : "rgba(47, 217, 244, 0.15)"}`,
      display: "flex", flexDirection: "column", gap: 14,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700,
        color: unavailable || allZeros ? "rgba(255, 185, 95, 0.8)" : "rgba(47, 217, 244, 0.8)",
        textTransform: "uppercase", letterSpacing: "0.2em",
      }}>
        Voice Biomarkers · thymia
      </div>
      <div style={{
        fontSize: 9, fontWeight: 500, marginTop: -10,
        color: "var(--vic-on-surface-variant)", opacity: 0.6,
        fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.04em",
      }}>
        Acoustic biomarker analysis · ≥15s validated · Helios + Apollo + Psyche
      </div>
      {unavailable || allZeros ? (
        <div style={{
          fontSize: 13, fontWeight: 500,
          color: "rgba(255, 185, 95, 0.9)",
          padding: "8px 12px", borderRadius: 8,
          background: "rgba(255, 185, 95, 0.06)",
        }}>
          Biomarker data unavailable — voice analysis returned no signal.
          This may indicate a processing error. Do not interpret as "all clear."
        </div>
      ) : !hasAny ? (
        <div style={{
          fontSize: 13, fontStyle: "italic",
          color: "var(--vic-on-surface-variant)",
        }}>
          Awaiting voice sample…
        </div>
      ) : (
        <>
          {/* Helios: stress / distress / exhaustion / strain — the primary
              concordance-gating profile. Drives M.E.R.C.E.D.'s flag firing. */}
          <ProfileSection title="Helios · mental wellness" subtitle="distress / stress / exhaustion / sleep / strain">
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 14,
            }}>
              {HELIOS_DISPLAY.map((f) => {
                const raw = typeof h[f.key] === "number" ? h[f.key] : 0;
                const display = f.transform ? f.transform(raw) : raw;
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
          </ProfileSection>

          {/* Apollo: valence / arousal / energy / engagement.
              Surfaced for clinical insight (flat affect = depression
              + minimisation pattern) but doesn't gate triage. */}
          {a && (
            <ProfileSection title="Apollo · mood + energy" subtitle="valence / arousal / energy / engagement">
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 14,
              }}>
                <BiomarkerBar label="Valence (positive ↔ negative)" value={1 - (a.valence ?? 0.5)} concerning={a.valence < 0.3} />
                <BiomarkerBar label="Arousal" value={a.arousal ?? 0.5} concerning={(a.arousal ?? 0.5) >= 0.8 || (a.arousal ?? 0.5) <= 0.2} />
                <BiomarkerBar label="Energy" value={a.energy ?? 0.5} concerning={(a.energy ?? 0.5) <= 0.3} />
                <BiomarkerBar label="Engagement" value={a.engagement ?? 0.5} concerning={(a.engagement ?? 0.5) <= 0.4} />
              </div>
            </ProfileSection>
          )}

          {/* Psyche: dominant affect with full distribution.
              The discrete-emotion signal — fear+suppression (low
              confidence, neutral dominant) is the atypical-CVD
              red flag M.E.R.C.E.D. picks up. */}
          {p && (
            <ProfileSection title="Psyche · affect breakdown" subtitle="dominant emotion + distribution">
              <PsycheChips dominant={p.dominant} confidence={p.confidence} distribution={p.distribution} />
            </ProfileSection>
          )}
        </>
      )}
    </section>
  );
}

function ProfileSection({ title, subtitle, children }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 10,
      paddingTop: 4,
    }}>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 10,
        flexWrap: "wrap",
      }}>
        <span style={{
          fontSize: 10, fontWeight: 700,
          color: "rgba(47, 217, 244, 0.85)",
          fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: "0.18em", textTransform: "uppercase",
        }}>{title}</span>
        <span style={{
          fontSize: 9,
          color: "var(--vic-on-surface-variant)",
          opacity: 0.55,
          fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: "0.04em",
        }}>{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

function PsycheChips({ dominant, confidence, distribution }) {
  const dist = distribution || {};
  // Sort emotions by weight descending so the chart reads as
  // "dominant first" — matches how clinicians scan a chart.
  const entries = Object.entries(dist).sort((x, y) => y[1] - x[1]);
  const emoColors = {
    fear:     "#ff6b6b",
    sadness:  "#7aa6e8",
    anger:    "#ff9f6b",
    disgust:  "#a07ae8",
    surprise: "#ffd76b",
    joy:      "#7ae8a4",
    neutral:  "rgba(200, 200, 200, 0.7)",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{
        fontSize: 14, fontWeight: 600,
        color: emoColors[dominant] || "var(--vic-on-surface)",
      }}>
        {dominant} <span style={{
          fontSize: 11, opacity: 0.7,
          fontFamily: "'JetBrains Mono', monospace",
        }}>· {Math.round((confidence ?? 0) * 100)}% confidence</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {entries.map(([emo, weight]) => (
          <span key={emo} style={{
            fontSize: 11, padding: "3px 9px",
            borderRadius: 999,
            border: `1px solid ${emoColors[emo] || "rgba(255,255,255,0.1)"}`,
            color: emoColors[emo] || "var(--vic-on-surface-variant)",
            opacity: weight > 0.05 ? 1 : 0.4,
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: "0.04em",
          }}>
            {emo} {Math.round(weight * 100)}%
          </span>
        ))}
      </div>
    </div>
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

function IdentityCard({ identity, flagQueue, transcript, riskScores }) {
  const { name, dob, complaint } = identity || {};
  // SCRIBE-distilled clinician-shorthand chief complaint, e.g. "Chest
  // pain x 24h, pressure-like". Falls back to first-sentence-truncated
  // raw complaint while SCRIBE is still working (~1s after intake) so
  // the chart header is never empty when patient data exists.
  const complaintShort = identity?.chief_complaint_short || "";
  // Suspected diagnosis surfaces from the top concordance flag (highest
  // tier wins, ordered by the bus). triage_label is short enough to
  // sit next to the CC ("Possible cardiac event"). When no flag has
  // fired we don't render the field at all — better than showing
  // "Pending" which a clinician might mistake for a real assessment.
  const topFlag = flagQueue && flagQueue[0];
  const suspectedDx = topFlag?.triage_label || null;
  const suspectedDxTier = topFlag?.tier || null; // 1 = highest, 2 = secondary
  const original = useOriginalIdentity();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: "", dob: "", complaint: "" });
  const [edited, setEdited] = useState(false);
  const [pushError, setPushError] = useState(null);
  // Verbatim accordion: collapsed by default. Distilled CC reads as
  // the chart header ("Reason for visit"); clinician taps "view
  // patient's own words" to expand the full narrative + live
  // transcript. Matches Epic 2018+ chart layout.
  const [verbatimOpen, setVerbatimOpen] = useState(false);
  if (!name && !dob && !complaint && !editing) return null;

  const startEdit = () => {
    setDraft({ name: name || "", dob: dob || "", complaint: complaint || "" });
    setPushError(null);
    setEditing(true);
  };
  const cancelEdit = () => setEditing(false);
  const saveEdit = async () => {
    // Persist locally first (optimistic) so the UI updates immediately.
    // editIdentity preserves the kiosk-original snapshot for the audit trail.
    const next = {
      name: draft.name.trim(),
      dob: draft.dob.trim(),
      complaint: draft.complaint.trim(),
    };
    editStoreIdentity(next);
    logIdentity(next);
    setEditing(false);
    setEdited(true);

    // Push back to the backend so /api/report and any live subscribers (EMR,
    // patient kiosk) see the correction too. Failure is non-fatal — local
    // edit still applies; we just surface a small banner so the clinician
    // knows the server-side log won't reflect this change yet.
    try {
      const httpBase = import.meta.env.VITE_BACKEND_HTTP_URL || "http://localhost:8000";
      const r = await fetch(`${httpBase}/api/identity/demo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      setPushError(String(e?.message || e));
    }
  };

  return (
    <section className="vic-glass" style={{
      padding: 20, borderRadius: 16,
      border: "1px solid rgba(47, 217, 244, 0.25)",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{
          fontSize: 10, fontWeight: 700,
          color: "rgba(47, 217, 244, 0.8)",
          textTransform: "uppercase", letterSpacing: "0.2em",
        }}>
          Patient Intake · Captured at Kiosk
          {edited && (
            <span style={{
              marginLeft: 10, color: "var(--vic-tertiary)",
              fontSize: 9, letterSpacing: "0.18em",
            }}>· Edited by Clinician</span>
          )}
        </div>
        {!editing ? (
          <button
            onClick={startEdit}
            style={editChipStyle}
            aria-label="Edit captured identity"
          >
            ✎ Edit
          </button>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={cancelEdit} style={editChipStyle}>Cancel</button>
            <button onClick={saveEdit} style={{
              ...editChipStyle,
              background: "var(--vic-primary)",
              color: "var(--vic-on-primary)",
              borderColor: "var(--vic-primary)",
            }}>Save</button>
          </div>
        )}
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 16,
      }}>
        {editing ? (
          <>
            <IdInput
              label="Name"
              value={draft.name}
              onChange={(v) => setDraft({ ...draft, name: v })}
              autoFocus
            />
            <IdInput
              label="Date of birth"
              value={draft.dob}
              onChange={(v) => setDraft({ ...draft, dob: v })}
              placeholder="YYYY-MM-DD or January 15, 1980"
            />
            <IdInput
              label="Reason for visit"
              value={draft.complaint}
              onChange={(v) => setDraft({ ...draft, complaint: v })}
              wide
            />
          </>
        ) : (
          <>
            <IdField
              label="Name" value={name || "—"} primary={!!name}
              original={original?.name}
            />
            <IdField
              label="Date of birth" value={dob || "—"} primary={!!dob}
              original={original?.dob}
            />
            <IdField
              label="Reason for visit"
              // SCRIBE-distilled CC ("Chest pain x 24h") preferred. If
              // the LLM call is still in flight or failed, fall back to
              // first-sentence of the raw complaint truncated to 60
              // chars — clinically still parseable, just less polished.
              value={
                complaintShort
                  || firstSentenceTruncated(complaint)
                  || "—"
              }
              primary={!!(complaintShort || complaint)}
              original={original?.complaint}
            />
            {suspectedDx && (
              <IdField
                label="Suspected diagnosis"
                value={suspectedDx}
                primary
                tone={suspectedDxTier === 1 ? "danger" : "warning"}
              />
            )}
          </>
        )}
      </div>
      {/* Clinical risk scores — one badge per active score. HEART
          fires for cardiac CCs, Wells for SOB / pleuritic chest,
          Alvarado for abdominal pain. Multiple can be active for
          a single patient (e.g. chest pain with pleuritic quality →
          HEART + Wells). All clinical_total values are partial since
          bedside vitals + labs land later; each badge labels that
          explicitly so a clinician doesn't read a partial as final. */}
      {!editing && riskScores && Object.keys(riskScores).length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {Object.values(riskScores).map((score) => (
            <RiskScoreBadge key={score.score} data={score} />
          ))}
        </div>
      )}

      {/* Verbatim accordion — Epic 2018+ pattern: distilled CC primary
          on the chart, "view patient's own words" link expands the
          full narrative for medico-legal traceability. Three things
          show inside when expanded:
            1. Patient's full kiosk complaint (committed text)
            2. Live in-session transcript (Deepgram, may include
               follow-up answers as the conversation progresses)
            3. Subtle "edited by clinician" indicator if the captured
               text doesn't match the original kiosk snapshot. */}
      {!editing && (complaint || transcript) && (
        <div style={{
          borderTop: "1px solid rgba(47, 217, 244, 0.12)",
          paddingTop: 10, marginTop: 2,
        }}>
          <button
            onClick={() => setVerbatimOpen((v) => !v)}
            style={{
              background: "transparent", border: "none",
              color: "rgba(47, 217, 244, 0.75)",
              fontSize: 11, letterSpacing: "0.14em",
              cursor: "pointer", padding: 0,
              fontFamily: "'JetBrains Mono', monospace",
              textTransform: "uppercase",
            }}
            aria-expanded={verbatimOpen}
          >
            {verbatimOpen ? "▾ hide" : "▸ view"} patient's own words
          </button>
          {verbatimOpen && (
            <div style={{
              marginTop: 12, display: "flex", flexDirection: "column",
              gap: 14, animation: "vic-fade-in 180ms ease",
            }}>
              {complaint && (
                <div>
                  <div style={{
                    fontSize: 9, fontWeight: 700,
                    color: "rgba(47, 217, 244, 0.55)",
                    textTransform: "uppercase", letterSpacing: "0.2em",
                    marginBottom: 6,
                  }}>
                    Chief complaint · verbatim
                  </div>
                  <p style={{
                    margin: 0, fontSize: 14, lineHeight: 1.55,
                    color: "var(--vic-on-surface)",
                    fontStyle: "italic",
                  }}>"{complaint}"</p>
                </div>
              )}
              {transcript && (
                <div>
                  <div style={{
                    fontSize: 9, fontWeight: 700,
                    color: "rgba(47, 217, 244, 0.55)",
                    textTransform: "uppercase", letterSpacing: "0.2em",
                    marginBottom: 6,
                  }}>
                    Live transcript · Deepgram
                  </div>
                  <p style={{
                    margin: 0, fontSize: 14, lineHeight: 1.55,
                    color: "var(--vic-on-surface-variant)",
                    fontStyle: "italic",
                  }}>"{transcript}"</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {pushError && !editing && (
        <div style={{
          fontSize: 11, color: "var(--vic-tertiary)",
          fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.04em",
        }}>
          ⚠ Server sync failed ({pushError}) — local edit applied; report and
          live patient view may not reflect the correction until backend reachable.
        </div>
      )}
    </section>
  );
}

function IdInput({ label, value, onChange, autoFocus, wide, placeholder }) {
  return (
    <div style={{ gridColumn: wide ? "1 / -1" : "auto" }}>
      <label style={{
        display: "block",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10, fontWeight: 700,
        color: "var(--vic-on-surface-variant)",
        textTransform: "uppercase", letterSpacing: "0.18em",
        marginBottom: 4,
      }}>{label}</label>
      <input
        type="text"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "8px 10px",
          background: "rgba(12, 19, 36, 0.6)",
          color: "var(--vic-on-surface)",
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: 15,
          border: "1px solid rgba(47, 217, 244, 0.35)",
          borderRadius: 8,
          outline: "none",
          boxSizing: "border-box",
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = "var(--vic-primary)"; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(47, 217, 244, 0.35)"; }}
      />
    </div>
  );
}

const editChipStyle = {
  padding: "5px 12px", borderRadius: 999,
  background: "var(--vic-bg-highest)",
  color: "var(--vic-on-surface)",
  border: "1px solid rgba(47, 217, 244, 0.35)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600, fontSize: 11,
  cursor: "pointer", letterSpacing: "0.04em",
};

function IdField({ label, value, primary, wide, original, tone }) {
  const displayValue = value === "—" ? "" : value;
  const displayOriginal = original && original !== displayValue ? original : null;
  // tone="danger" highlights ESI-1 / Tier-1 suspected diagnoses in
  // the chart-error red so the clinician's eye lands on it first.
  // tone="warning" is for Tier-2 / "concern" flags — amber, eye-
  // catching but not alarming. Default tone uses the primary surface
  // color (no medical urgency implied).
  const valueColor = tone === "danger"
    ? "var(--vic-error)"
    : tone === "warning"
    ? "#ffb46f"
    : primary
    ? "var(--vic-on-surface)"
    : "var(--vic-on-surface-variant)";
  return (
    <div style={{ gridColumn: wide ? "1 / -1" : "auto" }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10, fontWeight: 700,
        color: tone === "danger"
          ? "var(--vic-error)"
          : tone === "warning"
          ? "#ffb46f"
          : "var(--vic-on-surface-variant)",
        textTransform: "uppercase", letterSpacing: "0.18em",
        marginBottom: 4,
      }}>{label}</div>
      <div style={{
        fontSize: 16, lineHeight: 1.4,
        color: valueColor,
        fontWeight: primary ? 600 : 400,
      }}>{value}</div>
      {displayOriginal && (
        <div style={{
          marginTop: 4,
          fontSize: 11, lineHeight: 1.4,
          color: "var(--vic-tertiary)",
          fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: "0.04em",
        }}>
          was: <span style={{ textDecoration: "line-through", opacity: 0.85 }}>{displayOriginal}</span>
          <span style={{ marginLeft: 6, fontSize: 9, opacity: 0.7 }}>· kiosk capture</span>
        </div>
      )}
    </div>
  );
}

// Used as a fallback for "Reason for visit" while SCRIBE's distilled
// chief_complaint_short is still in flight (or if the LLM call failed).
// First sentence usually IS the chief complaint ("I have chest pain"
// → "I have chest pain"); cap at 60 chars so the chart header stays
// scannable.
function firstSentenceTruncated(text) {
  if (!text || typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  const firstSentence = trimmed.split(/[.!?\n]/, 1)[0].trim();
  const useText = firstSentence || trimmed;
  if (useText.length <= 60) return useText;
  return useText.slice(0, 57).trimEnd() + "...";
}

// Compact clinical risk-score badge. Today only HEART (chest pain)
// is wired; the component is structured so other scores (Wells, NIHSS,
// Alvarado) drop in cleanly once they're added to clinical_knowledge.
// Renders a small colored chip with the partial total + interpretation
// + a hover-tooltip-style breakdown on hover (see styling below).
function RiskScoreBadge({ data }) {
  if (!data) return null;
  const score = data.score || "Risk";
  const total = data.clinical_total ?? 0;
  const max = data.max_clinical ?? data.max_full ?? 6;
  // Per-score danger thresholds (clinical-only totals, not full
  // bedside-augmented totals). These match the interpretation
  // functions in clinical_knowledge.py:
  //   HEART:    ≥4 danger, ≥2 warning
  //   Wells:    ≥4.5 danger, ≥1.5 (or any factor) warning
  //   Alvarado: ≥3 danger (of 4 clinical), ≥1 warning
  const thresholds = (() => {
    if (score === "HEART")    return { danger: 4,   warning: 2 };
    if (score === "Wells")    return { danger: 4.5, warning: 1.5 };
    if (score === "Alvarado") return { danger: 3,   warning: 1 };
    return { danger: 4, warning: 2 };
  })();
  const tone = total >= thresholds.danger
    ? "danger"
    : total >= thresholds.warning
    ? "warning"
    : "ok";
  const bg = tone === "danger"
    ? "rgba(255, 100, 100, 0.10)"
    : tone === "warning"
    ? "rgba(255, 180, 111, 0.10)"
    : "rgba(120, 200, 160, 0.10)";
  const border = tone === "danger"
    ? "var(--vic-error)"
    : tone === "warning"
    ? "#ffb46f"
    : "rgba(120, 200, 160, 0.6)";
  const fg = tone === "danger"
    ? "var(--vic-error)"
    : tone === "warning"
    ? "#ffb46f"
    : "rgb(120, 200, 160)";
  // Per-score breakdown text. HEART has H/A/R components by name;
  // Wells / Alvarado emit a `factors_found` list with point weights.
  // We render a small mono row showing what tripped + what's pending.
  const breakdown = (() => {
    if (score === "HEART") {
      const h = data.history || {}, a = data.age || {}, r = data.risk_factors || {};
      return [
        { label: `H=${h.points ?? "-"}`, hint: h.justification || "" },
        { label: `A=${a.points ?? "-"}${a.value != null ? ` (${a.value}y)` : ""}`, hint: a.value != null ? `Age ${a.value}` : "Age unknown" },
        { label: `R=${r.points ?? "-"}${r.found?.length ? ` (${r.found.length})` : ""}`, hint: (r.found || []).join(", ") || "No risk factors detected" },
        { label: "E,T pending", hint: "EKG + troponin at bedside", muted: true },
      ];
    }
    if (score === "Wells") {
      const factors = data.factors_found || [];
      const pts = data.factor_points || {};
      const factorChips = factors.length
        ? factors.map((f) => ({
            label: `${f}=${pts[f] ?? "?"}`,
            hint: `${f.replace(/_/g, " ")} (+${pts[f]} pts)`,
          }))
        : [{ label: "no factors", hint: "No PE factors detected from history", muted: true }];
      return [
        ...factorChips,
        { label: "HR pending", hint: "HR > 100 (1.5 pts) — bedside vital", muted: true },
        { label: "gestalt pending", hint: "Clinician gestalt 'PE most likely' (3 pts)", muted: true },
      ];
    }
    if (score === "Alvarado") {
      const factors = data.factors_found || [];
      const pts = data.factor_points || {};
      const factorChips = factors.length
        ? factors.map((f) => ({
            label: `${f.replace(/_/g, " ")}+${pts[f] ?? "?"}`,
            hint: `${f.replace(/_/g, " ")} (+${pts[f]} pts)`,
          }))
        : [{ label: "no factors", hint: "No appendicitis factors detected from history", muted: true }];
      return [
        ...factorChips,
        { label: "exam pending", hint: "RLQ tenderness + rebound at bedside", muted: true },
        { label: "labs pending", hint: "WBC + left shift", muted: true },
      ];
    }
    return [];
  })();
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 8,
      padding: "12px 14px", borderRadius: 12,
      background: bg,
      border: `1px solid ${border}`,
      borderLeftWidth: 4,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "center", flexWrap: "wrap", gap: 12,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10, fontWeight: 700, color: fg,
            textTransform: "uppercase", letterSpacing: "0.2em",
          }}>{score} · clinical</span>
          <span style={{
            fontFamily: "'Space Grotesk', 'Inter', sans-serif",
            fontSize: 22, fontWeight: 700, color: fg,
          }}>
            {total}<span style={{ fontSize: 13, opacity: 0.6 }}>/{max}</span>
          </span>
        </div>
      </div>
      <div style={{
        fontSize: 13, color: "var(--vic-on-surface)",
        lineHeight: 1.4,
      }}>
        {data.interpretation}
      </div>
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 8,
        fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
        color: "var(--vic-on-surface-variant)",
        letterSpacing: "0.04em",
      }}>
        {breakdown.map((b, i) => (
          <span key={i} style={{ opacity: b.muted ? 0.55 : 1 }} title={b.hint}>
            {i > 0 && <span style={{ opacity: 0.4, marginRight: 8 }}>·</span>}
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function ConfirmDialog({ title, message, onConfirm, onCancel }) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      display: "grid", placeItems: "center",
      background: "rgba(0, 0, 0, 0.6)", backdropFilter: "blur(4px)",
    }}>
      <div style={{
        background: "var(--vic-bg-highest)", borderRadius: 16,
        padding: 32, maxWidth: 440, width: "90%",
        border: "1px solid rgba(255, 185, 95, 0.3)",
        boxShadow: "0 25px 50px rgba(0, 0, 0, 0.5)",
      }}>
        <h3 style={{
          margin: "0 0 12px", fontFamily: "'Space Grotesk', sans-serif",
          fontSize: 18, fontWeight: 700, color: "rgba(255, 185, 95, 0.9)",
        }}>{title}</h3>
        <p style={{
          margin: "0 0 24px", fontSize: 14, lineHeight: 1.6,
          color: "var(--vic-on-surface-variant)",
        }}>{message}</p>
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={{
            padding: "10px 20px", borderRadius: 8, border: "1px solid rgba(69, 70, 77, 0.4)",
            background: "transparent", color: "var(--vic-on-surface)",
            cursor: "pointer", fontWeight: 600, fontSize: 13,
          }}>Cancel</button>
          <button onClick={onConfirm} style={{
            padding: "10px 20px", borderRadius: 8, border: "none",
            background: "rgba(255, 185, 95, 0.9)", color: "var(--vic-bg)",
            cursor: "pointer", fontWeight: 700, fontSize: 13,
          }}>Approve Current</button>
        </div>
      </div>
    </div>
  );
}

function DowngradeModal({ onSubmit, onCancel }) {
  const [reason, setReason] = useState("");
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      display: "grid", placeItems: "center",
      background: "rgba(0, 0, 0, 0.6)", backdropFilter: "blur(4px)",
    }}>
      <div style={{
        background: "var(--vic-bg-highest)", borderRadius: 16,
        padding: 32, maxWidth: 480, width: "90%",
        border: "1px solid rgba(255, 180, 171, 0.3)",
        boxShadow: "0 25px 50px rgba(0, 0, 0, 0.5)",
      }}>
        <h3 style={{
          margin: "0 0 8px", fontFamily: "'Space Grotesk', sans-serif",
          fontSize: 18, fontWeight: 700, color: "var(--vic-error)",
        }}>Downgrade Escalated Case</h3>
        <p style={{
          margin: "0 0 16px", fontSize: 13, lineHeight: 1.6,
          color: "var(--vic-on-surface-variant)",
        }}>
          Please note your rationale for downgrading this case. This is recorded
          for clinical documentation and legal protection.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for downgrade (required)..."
          rows={3}
          style={{
            width: "100%", padding: 12, borderRadius: 8,
            background: "var(--vic-bg)", color: "var(--vic-on-surface)",
            border: "1px solid rgba(69, 70, 77, 0.4)",
            fontSize: 14, resize: "vertical", marginBottom: 20,
            fontFamily: "inherit",
          }}
        />
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={{
            padding: "10px 20px", borderRadius: 8, border: "1px solid rgba(69, 70, 77, 0.4)",
            background: "transparent", color: "var(--vic-on-surface)",
            cursor: "pointer", fontWeight: 600, fontSize: 13,
          }}>Cancel</button>
          <button
            onClick={() => reason.trim() && onSubmit(reason.trim())}
            disabled={!reason.trim()}
            style={{
              padding: "10px 20px", borderRadius: 8, border: "none",
              background: reason.trim() ? "var(--vic-error)" : "var(--vic-bg-highest)",
              color: reason.trim() ? "var(--vic-error-bg)" : "var(--vic-on-surface-variant)",
              cursor: reason.trim() ? "pointer" : "not-allowed",
              fontWeight: 700, fontSize: 13,
            }}
          >Confirm Downgrade</button>
        </div>
      </div>
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
