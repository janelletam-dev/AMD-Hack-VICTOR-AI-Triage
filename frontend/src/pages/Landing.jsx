import { Link } from "react-router-dom";

export default function Landing() {
  return (
    <div style={{
      minHeight: "100%", display: "flex", flexDirection: "column",
      background: "#f3f5f7", color: "#0f1a2a",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <header style={{
        padding: "16px 32px", display: "flex", alignItems: "baseline",
        justifyContent: "space-between", borderBottom: "1px solid #dde2e8",
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", color: "#0f1a2a",
            letterSpacing: "0.22em", fontSize: 14,
          }}>
            V.I.C.T.O.R.
          </div>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
            textTransform: "uppercase", letterSpacing: "0.18em", color: "#7a8696",
          }}>
            voice-first triage
          </div>
        </div>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
          textTransform: "uppercase", letterSpacing: "0.18em", color: "#7a8696",
        }}>
          demo · v0.1
        </div>
      </header>

      <main style={{ flex: 1, display: "grid", placeItems: "center", padding: "0 32px" }}>
        <div style={{ maxWidth: 640, width: "100%" }}>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
            textTransform: "uppercase", letterSpacing: "0.18em", color: "#7a8696",
            marginBottom: 12,
          }}>
            choose a view
          </div>
          <h1 style={{ fontSize: 30, color: "#0f1a2a", fontWeight: 500, marginBottom: 8 }}>
            A voice-first triage agent for the Emergency Department.
          </h1>
          <p style={{ color: "#465364", lineHeight: 1.65, marginBottom: 40 }}>
            Catches cardiovascular presentations standard triage misses — by
            listening to <em>how</em> patients speak, not just what they say.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Link to="/patient" style={{
              background: "#ffffff", border: "1px solid #dde2e8", borderRadius: 8,
              padding: 20, textDecoration: "none", color: "#0f1a2a",
              transition: "border-color 0.2s",
            }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "#0e7c86"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "#dde2e8"}
            >
              <div style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
                textTransform: "uppercase", letterSpacing: "0.18em", color: "#7a8696",
                marginBottom: 8,
              }}>
                /patient
              </div>
              <div style={{ fontSize: 18, marginBottom: 4 }}>Patient Kiosk</div>
              <div style={{ color: "#7a8696", fontSize: 14 }}>
                Voice selection → triage interview → waiting screen.
              </div>
            </Link>
            <Link to="/clinician" style={{
              background: "#ffffff", border: "1px solid #dde2e8", borderRadius: 8,
              padding: 20, textDecoration: "none", color: "#0f1a2a",
              transition: "border-color 0.2s",
            }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "#0e7c86"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "#dde2e8"}
            >
              <div style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
                textTransform: "uppercase", letterSpacing: "0.18em", color: "#7a8696",
                marginBottom: 8,
              }}>
                /clinician
              </div>
              <div style={{ fontSize: 18, marginBottom: 4 }}>Clinician Dashboard</div>
              <div style={{ color: "#7a8696", fontSize: 14 }}>
                EMR-style: concordance · biomarkers · swarm · SOAP.
              </div>
            </Link>
          </div>
        </div>
      </main>

      <footer style={{
        padding: "16px 32px", borderTop: "1px solid #dde2e8",
        fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
        textTransform: "uppercase", letterSpacing: "0.18em", color: "#7a8696",
      }}>
        AMD MI300X · vLLM · Llama 3 8B · Deepgram Flux · Thymia · ElevenLabs
      </footer>
    </div>
  );
}
