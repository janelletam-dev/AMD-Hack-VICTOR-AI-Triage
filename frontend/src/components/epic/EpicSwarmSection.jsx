const AGENT_NODES = {
  "V.I.C.T.O.R.": { x: 140, y: 130, role: "triage leader", short: "VIC" },
  "M.E.R.C.E.D.": { x: 40, y: 50, role: "concordance", short: "MER" },
  "S.C.R.I.B.E.": { x: 240, y: 50, role: "soap note", short: "SCR" },
  "J.A.C.K.I.E.": { x: 40, y: 210, role: "patient voice", short: "JAC" },
  "E.L.M.E.R.":   { x: 240, y: 210, role: "evidence", short: "ELM" },
};

const AGENT_ORDER = ["V.I.C.T.O.R.", "M.E.R.C.E.D.", "S.C.R.I.B.E.", "J.A.C.K.I.E.", "E.L.M.E.R."];

const EDGES = [
  ["V.I.C.T.O.R.", "M.E.R.C.E.D."],
  ["V.I.C.T.O.R.", "S.C.R.I.B.E."],
  ["V.I.C.T.O.R.", "J.A.C.K.I.E."],
  ["V.I.C.T.O.R.", "E.L.M.E.R."],
];

export default function EpicSwarmSection({ activity = {}, logs = [] }) {
  const activeCount = Object.values(activity).filter(a => a?.status === "active").length;
  return (
    <div className="epic-section">
      <div className="epic-band">
        <span>VICTOR Agent Swarm</span>
        <span className="meta">{activeCount} active</span>
      </div>

      <div style={{ padding: "8px 6px 0", background: "#f8fbff" }}>
        <svg viewBox="0 0 280 240" style={{ width: "100%", display: "block" }}>
          <defs>
            <radialGradient id="emrHubGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(14,124,134,0.18)" />
              <stop offset="100%" stopColor="rgba(14,124,134,0)" />
            </radialGradient>
            <filter id="emrSoft" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.6" />
            </filter>
          </defs>

          {EDGES.map(([a, b]) => {
            const A = AGENT_NODES[a], B = AGENT_NODES[b];
            const live = activity[a]?.status === "active" && activity[b]?.status === "active";
            return (
              <g key={a + b}>
                <line x1={A.x} y1={A.y} x2={B.x} y2={B.y}
                  stroke={live ? "#0e7c86" : "#b8c4d4"}
                  strokeWidth={live ? 1.4 : 0.8}
                  strokeOpacity={live ? 0.9 : 0.7}
                  style={{ transition: "all .3s" }} />
                {live && (
                  <circle r="2.4" fill="#0e7c86">
                    <animateMotion dur="1.4s" repeatCount="indefinite"
                      path={`M ${A.x} ${A.y} L ${B.x} ${B.y}`} />
                  </circle>
                )}
              </g>
            );
          })}

          <circle cx={AGENT_NODES["V.I.C.T.O.R."].x} cy={AGENT_NODES["V.I.C.T.O.R."].y}
            r="42" fill="url(#emrHubGlow)" />

          {AGENT_ORDER.map((id) => {
            const n = AGENT_NODES[id];
            const live = activity[id]?.status === "active";
            const isHub = id === "V.I.C.T.O.R.";
            const r = isHub ? 22 : 18;
            return (
              <g key={id}>
                {live && (
                  <circle cx={n.x} cy={n.y} r={r + 6}
                    fill="none" stroke="#0e7c86" strokeWidth="1"
                    opacity="0.5" filter="url(#emrSoft)">
                    <animate attributeName="r" from={r + 2} to={r + 12} dur="1.6s" repeatCount="indefinite" />
                    <animate attributeName="opacity" from="0.6" to="0" dur="1.6s" repeatCount="indefinite" />
                  </circle>
                )}
                <circle cx={n.x} cy={n.y} r={r}
                  fill={live ? "#e3f2f3" : "#ffffff"}
                  stroke={live ? "#0e7c86" : (isHub ? "#4a5b75" : "#95acc7")}
                  strokeWidth={isHub ? 1.4 : 1}
                  style={{ transition: "all .3s" }} />
                <text x={n.x} y={n.y + 1} textAnchor="middle"
                  dominantBaseline="middle"
                  fontFamily="'JetBrains Mono', monospace"
                  fontSize={isHub ? 10 : 9}
                  fontWeight={isHub ? 700 : 500}
                  fill={live ? "#0e7c86" : "#0f2547"}>
                  {n.short}
                </text>
                <text x={n.x} y={n.y + r + 12} textAnchor="middle"
                  fontFamily="'JetBrains Mono', monospace"
                  fontSize="8" letterSpacing="0.12em"
                  fill="#4a5b75">
                  {n.role.toUpperCase()}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div style={{ borderTop: "1px solid var(--epic-grid-soft)" }}>
        {AGENT_ORDER.map((id) => {
          const act = activity[id];
          const isActive = act?.status === "active";
          return (
            <div key={id} className="epic-row" style={{ gridTemplateColumns: "96px 1fr 64px" }}>
              <div className="k" style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
                color: isActive ? "#0e7c86" : "#4a5b75", fontWeight: isActive ? 700 : 400,
              }}>{id}</div>
              <div className="v" style={{
                color: act?.action ? "#1a2332" : "#94a3b8",
                fontStyle: act?.action ? "normal" : "italic"
              }}>
                {act?.action || "idle"}
              </div>
              <div style={{
                padding: "3px 8px", fontSize: 10.5,
                color: isActive ? "#1f4d22" : "#4a5b75",
                background: isActive ? "var(--epic-band)" : "transparent",
                borderLeft: "1px solid var(--epic-grid-soft)", textAlign: "center", fontWeight: 600,
              }}>
                {isActive ? "ACTIVE" : "—"}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ borderTop: "1px solid var(--epic-grid-soft)", background: "#fafbfd" }}>
        <div style={{
          padding: "3px 10px", fontSize: 10.5, color: "#4a5b75",
          textTransform: "uppercase", letterSpacing: ".08em",
          borderBottom: "1px solid var(--epic-grid-soft)",
        }}>Processing log</div>
        <div style={{
          padding: "4px 10px", maxHeight: 120, overflow: "auto",
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, lineHeight: 1.7, color: "#4a5b75",
        }}>
          {logs.length === 0 ? (
            <span style={{ fontStyle: "italic", fontFamily: "'Segoe UI',sans-serif" }}>
              Awaiting first event…
            </span>
          ) : (
            logs.slice(-12).map((l, i) => (
              <div key={i}>
                <span style={{ color: "#1a2332" }}>{l.t}</span>{"  "}
                <span style={{ color: "#0e7c86", fontWeight: 700 }}>{l.agent}</span>{"  "}
                {l.msg}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
