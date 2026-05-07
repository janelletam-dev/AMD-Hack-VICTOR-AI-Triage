import { Link, useLocation } from "react-router-dom";

export default function TopNav({ activeTab = "Patient Queue", urgentOverride = true }) {
  const tabs = ["Dashboard", "Patient Queue", "Analytics", "Staffing"];
  return (
    <nav style={{
      position: "fixed", top: 0, left: 0, right: 0, height: 80, zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 32px",
      background: "rgba(12, 19, 36, 0.6)",
      backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
      boxShadow: "0 20px 50px rgba(47, 217, 244, 0.08)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
        <Link to="/clinician" style={{ textDecoration: "none" }}>
          <span style={{
            fontFamily: "'Space Grotesk', 'Inter', sans-serif",
            fontSize: 22, fontWeight: 700, letterSpacing: "-0.04em",
            color: "var(--vic-primary)",
          }}>
            V.I.C.T.O.R. ER Triage
          </span>
        </Link>
        <div style={{ display: "flex", gap: 24 }}>
          {tabs.map((t) => {
            const active = t === activeTab;
            return (
              <a
                key={t}
                href="#"
                onClick={(e) => e.preventDefault()}
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontSize: 14, letterSpacing: "-0.01em",
                  color: active ? "var(--vic-primary)" : "var(--vic-on-surface-variant)",
                  borderBottom: active ? "2px solid var(--vic-primary)" : "2px solid transparent",
                  paddingBottom: 4, textDecoration: "none",
                }}
              >
                {t}
              </a>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {urgentOverride && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            background: "rgba(255, 180, 171, 0.15)",
            color: "var(--vic-on-error-bg)",
            padding: "6px 14px", borderRadius: 999,
            border: "1px solid rgba(255, 180, 171, 0.3)",
            animation: "ping 2s infinite",
          }}>
            <span style={{ fontSize: 14 }}>⚠</span>
            <span style={{
              fontSize: 11, fontWeight: 700, textTransform: "uppercase",
              letterSpacing: "0.18em",
            }}>1 Urgent Override</span>
          </div>
        )}
        <button style={iconBtn}>🔔</button>
        <button style={iconBtn}>⚙</button>
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          paddingLeft: 16, borderLeft: "1px solid rgba(69, 70, 77, 0.3)",
        }}>
          <div style={{ textAlign: "right" }}>
            <p style={{
              margin: 0, fontSize: 11, fontWeight: 700, color: "#ffffff",
              textTransform: "uppercase", letterSpacing: "0.06em",
            }}>Janelle Tamayo, RN</p>
            <p style={{ margin: 0, fontSize: 10, color: "var(--vic-primary)" }}>
              Founder · Demo Operator
            </p>
          </div>
          <div style={{
            width: 40, height: 40, borderRadius: "50%",
            border: "1px solid rgba(47, 217, 244, 0.2)",
            background: "linear-gradient(135deg, #2e3447, #4a5168)",
            display: "grid", placeItems: "center",
            color: "var(--vic-primary)", fontSize: 14, fontWeight: 700,
          }}>JT</div>
        </div>
      </div>
    </nav>
  );
}

const iconBtn = {
  background: "transparent", border: "none", cursor: "pointer",
  width: 36, height: 36, borderRadius: "50%",
  display: "grid", placeItems: "center",
  color: "var(--vic-on-surface-variant)", fontSize: 16,
};
