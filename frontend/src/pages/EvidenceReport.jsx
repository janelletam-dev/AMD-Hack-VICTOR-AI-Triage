import { Link } from "react-router-dom";

export default function EvidenceReport() {
  const labelStyle = {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
    textTransform: "uppercase", letterSpacing: "0.18em", color: "#7a8696",
  };

  return (
    <div style={{
      maxWidth: 720, margin: "0 auto", padding: "48px 32px",
      fontFamily: "'Inter', system-ui, sans-serif", color: "#0f1a2a",
    }}>
      <div style={{ ...labelStyle, marginBottom: 12 }}>evidence report · E.L.M.E.R.</div>
      <h1 style={{ fontSize: 24, fontWeight: 500, marginBottom: 24 }}>Triage Encounter Report</h1>
      <div style={{
        background: "#ffffff", border: "1px solid #dde2e8", borderRadius: 8,
        padding: 24, color: "#465364", lineHeight: 1.65,
      }}>
        Report generation lands on Day 4. This page will render the markdown
        produced by E.L.M.E.R., including the ESI comparison table, biomarker
        trajectory, concordance flags, full SOAP note, and the cited MIMIC-IV
        evidence base.
      </div>
      <div style={{ marginTop: 16 }}>
        <Link to="/clinician" style={{ color: "#1a5fb4", fontSize: 13 }}>
          ← Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
