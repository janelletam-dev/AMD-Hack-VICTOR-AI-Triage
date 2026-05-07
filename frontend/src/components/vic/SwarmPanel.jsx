const AGENTS = [
  { id: "VICTOR",  full: "V.I.C.T.O.R.", role: "Intake Leader",        x: 50, y: 14, color: "var(--vic-primary)",    icon: "📋", size: 88 },
  { id: "ELMER",   full: "E.L.M.E.R.",   role: "Evidence Retrieval",   x: 88, y: 38, color: "var(--vic-secondary)",  icon: "📚", size: 72 },
  { id: "JACKIE",  full: "J.A.C.K.I.E.", role: "Equity Auditor",       x: 70, y: 84, color: "var(--vic-tertiary)",   icon: "⚖",  size: 72 },
  { id: "SCRIBE",  full: "S.C.R.I.B.E.", role: "Chart Writer",         x: 30, y: 84, color: "var(--vic-primary-light)", icon: "✎",  size: 72 },
  { id: "MERCED",  full: "M.E.R.C.E.D.", role: "Resource Dispatcher",  x: 12, y: 38, color: "var(--vic-secondary)",  icon: "🏥", size: 72 },
];

export default function SwarmPanel({ activeAgents = new Set(), processLoad = 87, log = [] }) {
  return (
    <section style={{
      background: "var(--vic-bg-low)",
      borderRadius: 16,
      border: "1px solid rgba(69, 70, 77, 0.15)",
      display: "flex", flexDirection: "column",
      height: "100%", minHeight: 600, overflow: "hidden",
    }}>
      <div style={{ padding: "20px 24px 12px", borderBottom: "1px solid rgba(69, 70, 77, 0.12)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
          <div>
            <span style={{
              fontFamily: "'Space Grotesk', sans-serif",
              color: "var(--vic-primary)", fontSize: 10, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: "0.3em",
            }}>
              System Processing
            </span>
            <h2 style={{
              margin: "4px 0 0", fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em",
              color: "var(--vic-on-surface)",
            }}>
              5-Agent Swarm
            </h2>
            <p style={{
              margin: "2px 0 0", fontSize: 11,
              color: "var(--vic-on-surface-variant)", opacity: 0.75,
              maxWidth: 360, lineHeight: 1.45,
            }}>
              Five internal agents collaborate behind the scenes. The
              patient hears <strong>one voice persona</strong> selected
              at the kiosk — Victor (male, ElevenLabs) or Jackie
              (female, ElevenLabs) — speaking on behalf of the swarm.
            </p>
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            background: "var(--vic-bg-high)", padding: "8px 12px",
            borderRadius: 8, border: "1px solid rgba(69, 70, 77, 0.18)",
          }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
              <span style={{
                fontSize: 9, color: "var(--vic-on-surface-variant)",
                textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.06em",
              }}>Process Load</span>
              <span style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontSize: 18, fontWeight: 700, color: "var(--vic-primary)",
              }}>{processLoad}%</span>
            </div>
            <Sparkline />
          </div>
        </div>
      </div>

      <div style={{ position: "relative", flex: 1, minHeight: 320 }}>
        <NetworkSvg activeAgents={activeAgents} />
        {AGENTS.map((a) => (
          <AgentNode key={a.id} agent={a} active={activeAgents.has(a.full)} />
        ))}
      </div>

      <TerminalLog log={log} />
    </section>
  );
}

function Sparkline() {
  const bars = [4, 8, 5, 10, 6];
  return (
    <div style={{
      width: 64, height: 36, background: "rgba(47, 217, 244, 0.05)",
      borderRadius: 6, display: "flex", alignItems: "center",
      justifyContent: "space-around", padding: "0 4px",
    }}>
      {bars.map((h, i) => (
        <div key={i} style={{
          width: 4, height: h * 2,
          background: i % 2 ? "var(--vic-primary)" : "rgba(47, 217, 244, 0.5)",
          borderRadius: 999,
        }} />
      ))}
    </div>
  );
}

function NetworkSvg({ activeAgents }) {
  return (
    <svg
      className="vic-network-glow"
      style={{
        position: "absolute", inset: 0, width: "100%", height: "100%",
        opacity: 0.5, pointerEvents: "none",
      }}
    >
      {/* edges between center hub and ring */}
      {AGENTS.slice(1).map((a) => (
        <line
          key={a.id}
          x1="50%" y1="14%" x2={`${a.x}%`} y2={`${a.y}%`}
          stroke={activeAgents.has(a.full) ? "var(--vic-primary)" : "rgba(255,255,255,0.18)"}
          strokeWidth={activeAgents.has(a.full) ? 2 : 1}
          strokeDasharray="4 4"
        />
      ))}
      <circle cx="50%" cy="50%" r="120" fill="none" stroke="rgba(47, 217, 244, 0.1)" strokeWidth="2" />
      <circle cx="50%" cy="50%" r="200" fill="none" stroke="rgba(47, 217, 244, 0.05)" strokeWidth="1" />
    </svg>
  );
}

function AgentNode({ agent, active }) {
  return (
    <div style={{
      position: "absolute", left: `${agent.x}%`, top: `${agent.y}%`,
      transform: "translate(-50%, -50%)",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
      pointerEvents: "auto",
    }}>
      <div className="vic-glass" style={{
        position: "relative",
        width: agent.size, height: agent.size, borderRadius: "50%",
        border: `1px solid ${agent.color}40`,
        display: "grid", placeItems: "center",
        boxShadow: active ? `0 0 30px ${agent.color}66` : `0 0 15px ${agent.color}22`,
        transition: "box-shadow 0.3s",
      }}>
        <span style={{ fontSize: agent.size > 80 ? 32 : 26, color: agent.color }}>{agent.icon}</span>
        {active && (
          <div style={{
            position: "absolute", inset: -3, borderRadius: "50%",
            border: `1px solid ${agent.color}`,
            animation: "ping 1.6s cubic-bezier(0,0,0.2,1) infinite",
          }} />
        )}
      </div>
      <div style={{ textAlign: "center" }}>
        <h3 style={{
          margin: 0, color: "#ffffff", fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 700, fontSize: 12, letterSpacing: "0.04em",
        }}>{agent.full}</h3>
        <p style={{
          margin: "2px 0 0", color: agent.color, fontSize: 9, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: "0.2em",
        }}>{agent.role}</p>
      </div>
    </div>
  );
}

function TerminalLog({ log }) {
  const items = log.length ? log : DEFAULT_LOG;
  return (
    <div className="vic-glass" style={{
      margin: "0 16px 16px", height: 180, borderRadius: 12,
      borderTop: "1px solid rgba(69, 70, 77, 0.2)",
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "8px 16px",
        background: "rgba(12, 19, 36, 0.4)",
        borderBottom: "1px solid rgba(69, 70, 77, 0.1)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", gap: 5 }}>
            <Dot c="rgba(255, 180, 171, 0.5)" />
            <Dot c="rgba(255, 185, 95, 0.5)" />
            <Dot c="rgba(192, 193, 255, 0.5)" />
          </div>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
            color: "var(--vic-on-surface-variant)",
            textTransform: "uppercase", letterSpacing: "0.18em",
          }}>
            Agent Communication Log_v2.04
          </span>
        </div>
        <span style={{
          display: "flex", alignItems: "center", gap: 6,
          fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
          color: "var(--vic-primary)",
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "var(--vic-primary)", animation: "ping 2s infinite",
          }} />
          UPLINK ACTIVE
        </span>
      </div>
      <div className="vic-scrollbar" style={{
        flex: 1, padding: 16, overflowY: "auto",
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
        display: "flex", flexDirection: "column", gap: 4,
      }}>
        {items.map((entry, i) => (
          <p key={i} style={{ margin: 0, color: entry.color || "var(--vic-on-surface-variant)" }}>
            <span style={{ color: entry.tsColor || entry.color || "var(--vic-primary)" }}>
              [{entry.ts}]
            </span>{" "}
            {entry.text}
          </p>
        ))}
      </div>
    </div>
  );
}

const DEFAULT_LOG = [
  { ts: "00:00", color: "var(--vic-on-surface-variant)", tsColor: "var(--vic-primary)",
    text: "V.I.C.T.O.R. awaiting patient session…" },
];

function Dot({ c }) {
  return <div style={{ width: 8, height: 8, borderRadius: "50%", background: c }} />;
}
