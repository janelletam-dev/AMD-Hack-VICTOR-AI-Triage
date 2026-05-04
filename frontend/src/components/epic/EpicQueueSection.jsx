const QUEUE = [
  { id: "demo", name: "Patient · demo", cc: "stomach pain", status: "Escalated", esi: "2" },
  { id: "r-002", name: "—", cc: "chest pain", status: "Urgent", esi: "2" },
  { id: "r-003", name: "—", cc: "fall", status: "Standard", esi: "3" },
  { id: "r-004", name: "—", cc: "headache", status: "Standard", esi: "3" },
  { id: "r-005", name: "—", cc: "ankle sprain", status: "Observation", esi: "4" },
];

export default function EpicQueueSection({ activeRoom, onSelect }) {
  return (
    <div className="epic-section">
      <div className="epic-band">
        <span>ED Track Board</span>
        <span className="meta">5 active · 1 escalated</span>
      </div>
      <div className="epic-row" style={{ gridTemplateColumns: "40px 1fr 80px 70px", background: "#e7eef6", fontWeight: 600 }}>
        <div className="k" style={{ background: "#e7eef6" }}>Bed</div>
        <div className="k" style={{ background: "#e7eef6" }}>Patient · CC</div>
        <div className="k" style={{ background: "#e7eef6" }}>Status</div>
        <div className="k" style={{ background: "#e7eef6", borderRight: "none" }}>ESI</div>
      </div>
      {QUEUE.map((p, i) => {
        const active = p.id === activeRoom;
        const tone = p.status === "Escalated" ? "#b3261e"
                   : p.status === "Urgent" ? "#0e7c86" : "#1a2332";
        return (
          <div key={p.id}
            onClick={() => onSelect(p.id)}
            className="epic-row"
            style={{
              gridTemplateColumns: "40px 1fr 80px 70px",
              cursor: "pointer",
              background: active ? "#fff7d6" : (i % 2 ? "var(--epic-row-alt)" : "var(--epic-row)"),
            }}>
            <div className="k" style={{
              background: "transparent",
              fontFamily: "'JetBrains Mono',monospace"
            }}>
              {12 + i}
            </div>
            <div className="v">
              <span style={{ fontWeight: active ? 600 : 400 }}>{p.name}</span>
              <span style={{ color: "#4a5b75", marginLeft: 6 }}>· {p.cc}</span>
            </div>
            <div className="v" style={{ color: tone, fontWeight: 600 }}>{p.status}</div>
            <div style={{
              padding: "3px 8px", borderLeft: "1px solid var(--epic-grid-soft)",
              fontFamily: "'JetBrains Mono',monospace", textAlign: "center"
            }}>
              {p.esi}
            </div>
          </div>
        );
      })}
    </div>
  );
}
