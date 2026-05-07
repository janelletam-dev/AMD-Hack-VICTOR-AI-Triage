import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { marked } from "marked";
import TopNav from "../components/vic/TopNav.jsx";
import { useSessionLog } from "../state/sessionLogStore.js";
import { HTTP_BASE } from "../lib/backend-urls.js";

// Parse the backend's markdown synchronously. The HTML comes from our own
// E.L.M.E.R. agent so we don't need a sanitiser here — but if this view
// ever renders user-controlled content, switch to DOMPurify.
marked.setOptions({ async: false, gfm: true, breaks: true });

export default function EvidenceReport() {
  const navigate = useNavigate();
  const sessionLog = useSessionLog();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [approved, setApproved] = useState(false);
  const [references, setReferences] = useState(null);

  // Reuse the same theme key as EmrView so the toggle there carries over.
  const [theme, setTheme] = useState(
    () => localStorage.getItem("vic-emr-theme") || "dark"
  );
  useEffect(() => { localStorage.setItem("vic-emr-theme", theme); }, [theme]);
  const isDark = theme === "dark";
  const t = isDark ? DARK : LIGHT;

  // The backend SessionLogStore is authoritative for real WS-driven sessions
  // — `/api/report` will use it and ignore this body's `session_log`. We
  // still send the local log so the frontend "Run Demo" flow (which fakes
  // events client-side without hitting the backend) keeps working as a
  // fallback.
  const requestBody = useMemo(
    () => ({
      room_id: "demo",
      session_log: {
        identity: sessionLog.identity,
        transcript_lines: sessionLog.transcript_lines,
        biomarker_summary: sessionLog.biomarker_summary,
        flags: sessionLog.flags,
        soap: sessionLog.soap,
        esi: sessionLog.esi,
        emergency: sessionLog.emergency,
      },
    }),
    [sessionLog]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(`${HTTP_BASE}/api/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`/api/report → ${r.status}`);
        return r.json();
      })
      .then((data) => { if (!cancelled) setReport(data); })
      .catch((e) => { if (!cancelled) setErr(String(e?.message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reference library is static — fetch once, ignore failures (the rest of
  // the report still works without it).
  useEffect(() => {
    let cancelled = false;
    fetch(`${HTTP_BASE}/api/references`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled && data) setReferences(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const reportHtml = useMemo(
    () => (report?.report ? marked.parse(report.report) : ""),
    [report]
  );

  return (
    <div style={{
      minHeight: "100vh",
      background: t.pageBg,
      color: t.text,
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      {isDark && <TopNav activeTab="Patient Queue" urgentOverride={!!sessionLog.emergency} />}
      <ThemeToggle theme={theme} onChange={setTheme} dark={isDark} />

      <main style={{
        maxWidth: 960, margin: "0 auto",
        padding: isDark ? "104px 24px 96px" : "56px 24px 96px",
      }}>
        <Header onBack={() => navigate("/clinician")} t={t} />

        {sessionLog.emergency && (
          <EmergencyBanner emergency={sessionLog.emergency} t={t} />
        )}

        <ReportPanel
          loading={loading}
          err={err}
          report={report}
          html={reportHtml}
          t={t}
          isDark={isDark}
        />

        {references && <ScientificBasis references={references} t={t} />}

        <ActionFooter
          approved={approved}
          ready={!!report && !loading}
          onApprove={() => setApproved(true)}
          t={t}
          isDark={isDark}
        />
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── themes

const DARK = {
  pageBg: "var(--vic-bg)",
  text: "var(--vic-on-surface)",
  textMuted: "var(--vic-on-surface-variant)",
  accent: "var(--vic-primary)",
  accentSoft: "rgba(47, 217, 244, 0.8)",
  accentBorder: "rgba(47, 217, 244, 0.35)",
  accentBg: "rgba(47, 217, 244, 0.06)",
  cardClass: "vic-glass",
  cardBorder: "1px solid rgba(47, 217, 244, 0.15)",
  cardBg: undefined,
  divider: "1px solid rgba(69, 70, 77, 0.3)",
  errorText: "var(--vic-error)",
  errorBg: "rgba(147, 0, 10, 0.18)",
  errorBorder: "1px solid rgba(255, 180, 171, 0.45)",
  errorContent: "var(--vic-on-error-bg)",
  ghostBtnBg: "var(--vic-bg-highest)",
  ghostBtnBorder: "1px solid rgba(69, 70, 77, 0.4)",
  primaryBtnBg: "linear-gradient(to right, var(--vic-primary), #008ea1)",
  primaryBtnColor: "var(--vic-on-primary)",
  primaryBtnGlow: "0 10px 30px rgba(47, 217, 244, 0.3)",
  approvedBg: "linear-gradient(to right, #1f7a3a, #2ea35a)",
  approvedColor: "#9be7b1",
  mdClass: "evidence-report-md",
};

const LIGHT = {
  pageBg: "#cdd9e6",
  text: "#0f1a2a",
  textMuted: "#465364",
  accent: "#1a5fb4",
  accentSoft: "#1a5fb4",
  accentBorder: "#95acc7",
  accentBg: "#fff",
  cardClass: "",
  cardBorder: "1px solid #95acc7",
  cardBg: "#fff",
  divider: "1px solid #95acc7",
  errorText: "#9d2630",
  errorBg: "#fde7e9",
  errorBorder: "1px solid #f4b1b8",
  errorContent: "#5a0e0a",
  ghostBtnBg: "#fff",
  ghostBtnBorder: "1px solid #95acc7",
  primaryBtnBg: "linear-gradient(to bottom, #2c5e9e, #1a4682)",
  primaryBtnColor: "#fff",
  primaryBtnGlow: "0 2px 4px rgba(15, 26, 42, 0.2)",
  approvedBg: "linear-gradient(to bottom, #2a8048, #1f6534)",
  approvedColor: "#1f7a3a",
  mdClass: "evidence-report-md light",
};

// ───────────────────────────────────────────────────────────────────── header

function Header({ onBack, t }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
        textTransform: "uppercase", letterSpacing: "0.2em",
        color: t.accentSoft, marginBottom: 8,
      }}>
        Evidence Report · E.L.M.E.R.
      </div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, flexWrap: "wrap",
      }}>
        <h1 style={{
          fontSize: 28, fontWeight: 600, margin: 0,
          fontFamily: "'Space Grotesk', sans-serif",
          letterSpacing: "-0.02em",
          color: t.text,
        }}>
          Triage Encounter Report
        </h1>
        <button
          onClick={onBack}
          style={{
            color: t.accent, fontSize: 13,
            border: `1px solid ${t.accentBorder}`,
            padding: "8px 14px", borderRadius: 10,
            background: t.accentBg,
            cursor: "pointer", fontWeight: 600,
            fontFamily: "'Space Grotesk', sans-serif",
          }}
        >
          ← Back to Triage Workspace
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── emergency

function EmergencyBanner({ emergency, t }) {
  return (
    <div style={{
      background: t.errorBg,
      border: t.errorBorder,
      borderRadius: 12, padding: "14px 18px", marginBottom: 16,
      color: t.errorText, fontSize: 14, lineHeight: 1.55,
    }}>
      <strong style={{ display: "block", fontSize: 15, marginBottom: 4 }}>
        🚨 Emergency Signal — {emergency.severity || "ESI-1"}
      </strong>
      <span style={{ color: t.errorContent }}>
        Patient said: <em>"{emergency.matched_phrase}"</em>
        {emergency.label ? ` · category: ${emergency.label}` : ""}
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────── report

function ReportPanel({ loading, err, report, html, t, isDark }) {
  if (loading) {
    return (
      <Card t={t}>
        <p style={{ margin: 0, color: t.textMuted }}>
          Generating evidence report — E.L.M.E.R. is synthesising the session log…
        </p>
      </Card>
    );
  }
  if (err) {
    return (
      <Card t={t}>
        <p style={{ margin: 0, color: t.errorText }}>
          Couldn't generate the report: <code style={codeStyle(isDark)}>{err}</code>
        </p>
        <p style={{ marginTop: 8, color: t.textMuted, fontSize: 13 }}>
          Make sure the backend is running on{" "}
          <code style={codeStyle(isDark)}>{HTTP_BASE}</code>.
        </p>
      </Card>
    );
  }
  if (!report) {
    return (
      <Card t={t}>
        <p style={{ margin: 0, color: t.textMuted }}>
          No report available yet.
        </p>
      </Card>
    );
  }
  return (
    <>
      <ScoreSummary report={report} t={t} />
      <Card t={t}>
        <div
          className={t.mdClass}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </Card>
    </>
  );
}

function ScoreSummary({ report, t }) {
  const std = report.esi_standard || 0;
  const adj = report.esi_adjusted || 0;
  const adjusted = adj && std && adj < std;
  const flagCount = report.flags?.length || 0;
  return (
    <Card t={t}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr 1fr",
        alignItems: "center", gap: 20,
      }}>
        <ScoreBlock label="Standard ESI" value={std || "—"} t={t} />
        <Arrow adjusted={adjusted} t={t} />
        <ScoreBlock
          label="V.I.C.T.O.R.-adjusted ESI"
          value={adj || "—"}
          highlight={adjusted}
          t={t}
        />
        <ScoreBlock
          label="Concordance flags"
          value={flagCount}
          highlight={flagCount > 0}
          t={t}
        />
      </div>
    </Card>
  );
}

function ScoreBlock({ label, value, highlight, t }) {
  return (
    <div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
        letterSpacing: "0.18em", textTransform: "uppercase",
        color: t.textMuted, marginBottom: 6,
      }}>{label}</div>
      <div style={{
        fontSize: 36, fontWeight: 600,
        fontFamily: "'Space Grotesk', sans-serif",
        letterSpacing: "-0.02em",
        color: highlight ? t.errorText : t.text,
      }}>{value}</div>
    </div>
  );
}

function Arrow({ adjusted, t }) {
  return (
    <div style={{
      color: adjusted ? t.errorText : t.textMuted,
      fontSize: 26, fontWeight: 700,
      textAlign: "center",
    }}>→</div>
  );
}

function Card({ children, t }) {
  return (
    <section className={t.cardClass} style={{
      padding: 22, marginBottom: 16,
      borderRadius: 16,
      border: t.cardBorder,
      background: t.cardBg,
      boxShadow: t.cardClass ? undefined : "0 1px 2px rgba(15, 26, 42, 0.06)",
    }}>
      {children}
    </section>
  );
}

const codeStyle = (isDark) => isDark ? ({
  fontFamily: "'JetBrains Mono', monospace",
  background: "rgba(47, 217, 244, 0.08)",
  border: "1px solid rgba(47, 217, 244, 0.2)",
  borderRadius: 4,
  padding: "1px 6px",
  fontSize: 12,
  color: "var(--vic-primary)",
}) : ({
  fontFamily: "'JetBrains Mono', monospace",
  background: "#eef3f9",
  border: "1px solid #cfd6de",
  borderRadius: 4,
  padding: "1px 6px",
  fontSize: 12,
  color: "#1a5fb4",
});

// ─────────────────────────────────────────────────────── scientific basis

function ScientificBasis({ references, t }) {
  const items = references?.references || [];
  const futureDatasets = references?.future_training_data?.datasets || [];
  if (!items.length) return null;
  return (
    <Card t={t}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
        letterSpacing: "0.2em", textTransform: "uppercase",
        color: t.accentSoft, marginBottom: 4,
      }}>
        Scientific Basis · Peer-Reviewed
      </div>
      <p style={{
        margin: "0 0 14px", fontSize: 12, color: t.textMuted,
        lineHeight: 1.5,
      }}>
        V.I.C.T.O.R.'s voice-biomarker triage is grounded in published
        clinical literature. These references back the concordance flags
        and ESI adjustments above.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {items.map((ref) => (
          <Citation key={ref.id} ref_={ref} t={t} />
        ))}
      </div>
      {futureDatasets.length > 0 && (
        <FutureDatasets datasets={futureDatasets} t={t} />
      )}
    </Card>
  );
}

function FutureDatasets({ datasets, t }) {
  return (
    <div style={{
      marginTop: 16, paddingTop: 14,
      borderTop: `1px dashed ${t.cardClass ? "rgba(47, 217, 244, 0.2)" : "#cfd6de"}`,
    }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
        letterSpacing: "0.18em", textTransform: "uppercase",
        color: t.textMuted, marginBottom: 6,
      }}>
        Roadmap · Future Fine-Tuning Datasets
      </div>
      <ul style={{
        margin: 0, paddingLeft: 18,
        fontSize: 12, lineHeight: 1.55, color: t.textMuted,
      }}>
        {datasets.map((d) => (
          <li key={d.id}>
            <strong style={{ color: t.text, fontWeight: 600 }}>{d.name}</strong>
            {" — "}{d.size}, {d.labels}.{" "}
            {d.url && (
              <a
                href={d.url} target="_blank" rel="noopener noreferrer"
                style={{ color: t.accent, textDecoration: "none" }}
              >link ↗</a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Citation({ ref_, t }) {
  return (
    <div style={{
      padding: "12px 14px", borderRadius: 10,
      background: t.cardClass ? "rgba(47, 217, 244, 0.04)" : "#f5f8fc",
      border: `1px solid ${t.cardClass ? "rgba(47, 217, 244, 0.12)" : "#dde7f1"}`,
    }}>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
        marginBottom: 4,
      }}>
        <span style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontSize: 13, fontWeight: 700, color: t.accent,
          letterSpacing: "-0.01em",
        }}>{ref_.short_cite}</span>
        {ref_.url && (
          <a
            href={ref_.url} target="_blank" rel="noopener noreferrer"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10, color: t.accent, textDecoration: "none",
              border: `1px solid ${t.accentBorder}`,
              padding: "1px 6px", borderRadius: 4,
              letterSpacing: "0.06em",
            }}
          >open ↗</a>
        )}
      </div>
      <div style={{
        fontSize: 13, lineHeight: 1.5,
        color: t.text, marginBottom: 6,
      }}>{ref_.title}</div>
      {ref_.key_findings?.length > 0 && (
        <ul style={{
          margin: "4px 0 0", paddingLeft: 18,
          fontSize: 12, lineHeight: 1.55, color: t.textMuted,
        }}>
          {ref_.key_findings.slice(0, 2).map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────── action bar

function ActionFooter({ approved, ready, onApprove, t, isDark }) {
  const enabled = ready && !approved;
  return (
    <div style={{
      display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
      marginTop: 20, paddingTop: 16,
      borderTop: t.divider,
    }}>
      <button
        onClick={onApprove}
        disabled={!enabled}
        style={{
          padding: "12px 22px", borderRadius: 12, border: "none",
          background: approved
            ? t.approvedBg
            : (ready ? t.primaryBtnBg : t.ghostBtnBg),
          color: ready ? t.primaryBtnColor : t.textMuted,
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 700, fontSize: 14,
          letterSpacing: "-0.01em",
          cursor: enabled ? "pointer" : "not-allowed",
          boxShadow: enabled ? t.primaryBtnGlow : "none",
        }}
      >
        {approved ? "✓ Approved & pushed (mock)" : "☁ Approve & Push to Chart"}
      </button>
      <button
        onClick={() => window.print()}
        disabled={!ready}
        style={{
          padding: "12px 20px", borderRadius: 12,
          background: t.ghostBtnBg,
          color: t.text,
          border: t.ghostBtnBorder,
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 600, fontSize: 13,
          cursor: ready ? "pointer" : "not-allowed",
        }}
      >
        Print
      </button>
      {approved && (
        <span style={{
          color: t.approvedColor, fontSize: 13, marginLeft: 4,
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          Mock action — no live EHR connection. See VICTOR_PRD.md §15.
        </span>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── theme toggle

function ThemeToggle({ theme, onChange, dark }) {
  return (
    <div style={{
      position: "fixed", top: dark ? 96 : 12, right: 24, zIndex: 60,
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
