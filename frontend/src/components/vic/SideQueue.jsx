const PATIENTS = [
  { id: "macaraeg", name: "R. Macaraeg", meta: "M / 59 · Exertion Fatigue", level: "ESCALATED CASE", ago: "2m ago", risk: "CRITICAL RISK" },
  { id: "jenkins",  name: "S. Jenkins",  meta: "F / 32 · Abdominal Pain",   level: "URGENT",          ago: "14m ago" },
  { id: "henderson",name: "T. Henderson",meta: "M / 19 · Wrist Fracture",   level: "STANDARD",        ago: "28m ago" },
  { id: "martinez", name: "L. Martinez", meta: "F / 45 · Persistent Cough", level: "STANDARD",        ago: "45m ago" },
];

const LEVEL_COLOR = {
  "ESCALATED CASE": "var(--vic-error)",
  "URGENT":         "var(--vic-tertiary)",
  "STANDARD":       "var(--vic-secondary)",
};

export default function SideQueue({ activeId = "macaraeg", onSelect }) {
  return (
    <aside style={{
      position: "fixed", top: 80, left: 0, bottom: 0, width: 320,
      background: "var(--vic-bg-low)",
      borderRight: "1px solid rgba(69, 70, 77, 0.15)",
      display: "flex", flexDirection: "column",
      paddingTop: 24, overflowY: "auto", zIndex: 40,
    }} className="vic-scrollbar">
      <div style={{ padding: "0 24px", marginBottom: 24 }}>
        <h2 style={{
          margin: 0, fontFamily: "'Space Grotesk', sans-serif",
          color: "var(--vic-primary)", fontWeight: 700, fontSize: 18,
          letterSpacing: "-0.01em",
        }}>
          ER Triage Queue
        </h2>
        <p style={{
          margin: "4px 0 0", color: "var(--vic-on-surface-variant)",
          fontSize: 11, fontWeight: 500,
        }}>
          12 Patients Waiting · V.I.C.T.O.R. Active
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 12px" }}>
        {PATIENTS.map((p) => {
          const isEscalated = p.level === "ESCALATED CASE";
          const isActive = p.id === activeId;
          return (
            <button
              key={p.id}
              onClick={() => onSelect?.(p.id)}
              style={{
                position: "relative", overflow: "hidden",
                background: isEscalated
                  ? "rgba(255, 180, 171, 0.08)"
                  : isActive ? "rgba(46, 52, 71, 0.6)" : "transparent",
                border: isEscalated
                  ? "1px solid rgba(255, 180, 171, 0.25)"
                  : "1px solid transparent",
                borderRadius: 12, padding: "16px",
                textAlign: "left", cursor: "pointer",
                color: "var(--vic-on-surface)",
                display: "flex", flexDirection: "column", gap: 8,
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => { if (!isEscalated) e.currentTarget.style.background = "rgba(46, 52, 71, 0.4)"; }}
              onMouseLeave={(e) => { if (!isEscalated && !isActive) e.currentTarget.style.background = "transparent"; }}
            >
              {isEscalated && (
                <div style={{
                  position: "absolute", right: 0, top: 0, bottom: 0,
                  width: 3, background: "var(--vic-error)",
                }} />
              )}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <span style={{
                  color: LEVEL_COLOR[p.level], fontSize: 10, fontWeight: 700,
                  textTransform: "uppercase", letterSpacing: "0.18em",
                }}>{p.level}</span>
                <span style={{ color: "var(--vic-on-surface-variant)", fontSize: 10 }}>{p.ago}</span>
              </div>
              <div>
                <h4 style={{
                  margin: 0, fontSize: 14, fontWeight: 600,
                  color: "var(--vic-on-surface)",
                }}>{p.name}</h4>
                <p style={{
                  margin: "2px 0 0", fontSize: 11,
                  color: "var(--vic-on-surface-variant)",
                }}>{p.meta}</p>
              </div>
              {p.risk && (
                <span style={{
                  display: "inline-block", padding: "2px 8px",
                  background: "rgba(255, 180, 171, 0.2)", color: "var(--vic-error)",
                  borderRadius: 999, fontSize: 9, fontWeight: 700,
                  textTransform: "uppercase", letterSpacing: "0.12em",
                  alignSelf: "flex-start",
                }}>{p.risk}</span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: "var(--vic-primary)", animation: "ping 2s infinite",
          }} />
          <span style={{
            color: "var(--vic-on-surface-variant)", fontSize: 10,
            textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 500,
          }}>
            Clinical Command Center Online
          </span>
        </div>
      </div>
    </aside>
  );
}
