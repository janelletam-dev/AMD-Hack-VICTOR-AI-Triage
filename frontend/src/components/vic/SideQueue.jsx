// Mock waiting-room queue used to give the dashboard a sense of being
// part of a real ED workflow during the demo. The CURRENT patient (the
// one driving the chart) is computed dynamically and slotted at the top
// of the queue — so when Janelle runs a session at the kiosk, her chart
// shows up here as the active case, not the hardcoded R. Macaraeg row
// the dashboard had during early development.
// Mock waiting-room rows are tagged `mock: true` so the rendered card
// can show a "DEMO" badge — judges and demo viewers should not read
// these as real patients. The current-patient row (computed from live
// state) is NOT mock and gets a "LIVE" badge instead.
const MOCK_WAITING = [
  { id: "jenkins",  name: "S. Jenkins",  meta: "F / 32 · Abdominal Pain",   level: "URGENT",          ago: "14m ago", mock: true },
  { id: "henderson",name: "T. Henderson",meta: "M / 19 · Wrist Fracture",   level: "STANDARD",        ago: "28m ago", mock: true },
  { id: "martinez", name: "L. Martinez", meta: "F / 45 · Persistent Cough", level: "STANDARD",        ago: "45m ago", mock: true },
];

const LEVEL_COLOR = {
  "ESCALATED CASE": "var(--vic-error)",
  "URGENT":         "var(--vic-tertiary)",
  "STANDARD":       "var(--vic-secondary)",
};

function _ageFromDob(dob) {
  if (!dob || typeof dob !== "string" || dob.length < 4) return null;
  try {
    const [y, m, d] = dob.split("-").map(Number);
    if (!y) return null;
    const now = new Date();
    let age = now.getFullYear() - y - ((now.getMonth() + 1, now.getDate()) < (m, d) ? 1 : 0);
    return age >= 0 && age < 150 ? age : null;
  } catch { return null; }
}

function _agoLabel(ts) {
  if (!ts) return "now";
  const ms = Date.now() - ts;
  if (ms < 60_000) return "now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function _buildCurrentPatientRow(identity, flagQueue, esi, sessionStartTs) {
  if (!identity) return null;
  const { name, dob, gender, complaint, chief_complaint_short } = identity;
  if (!name && !complaint && !dob) return null;

  // Format name as "F. Lastname" to match the mock queue style — it's
  // clinically conventional and keeps the row visually balanced with
  // the others.
  let displayName = name || "Patient";
  if (name && name.includes(" ")) {
    const parts = name.trim().split(/\s+/);
    const first = parts[0];
    const last = parts.slice(1).join(" ");
    displayName = `${first[0]}. ${last}`;
  }

  const age = _ageFromDob(dob);
  const sex = gender ? (gender[0] || "").toUpperCase() : null;
  const ageSex = [sex, age].filter(v => v !== null && v !== undefined && v !== "").join(" / ");
  const cc = chief_complaint_short || (complaint ? complaint.slice(0, 40) : "Awaiting chief complaint");
  const meta = ageSex ? `${ageSex} · ${cc}` : cc;

  const adjustedEsi = esi?.victor_esi || esi?.adjusted;
  const standardEsi = esi?.standard_esi || esi?.standard;
  const hasFlag = Array.isArray(flagQueue) && flagQueue.length > 0;
  const escalated = !!(adjustedEsi && standardEsi && adjustedEsi < standardEsi);

  let level = "STANDARD";
  let risk = null;
  if (escalated || hasFlag || (adjustedEsi && adjustedEsi <= 2)) {
    level = "ESCALATED CASE";
    risk = hasFlag ? "CONCORDANCE FLAG" : "ESI ESCALATED";
  } else if (adjustedEsi === 3) {
    level = "URGENT";
  }

  return {
    id: "current",
    name: displayName,
    meta,
    level,
    ago: _agoLabel(sessionStartTs),
    risk,
    isCurrent: true,
  };
}

export default function SideQueue({
  activeId = "current",
  onSelect,
  currentPatient,
  identity,
  flagQueue,
  esi,
  sessionStartTs,
}) {
  // Build the current-patient row from live state if the caller passed
  // identity / flagQueue / esi instead of a pre-built row. Either path
  // works; identity-driven is the new dashboard wiring, the prebuilt
  // form keeps backwards-compatible callers happy.
  const computedCurrent = currentPatient || _buildCurrentPatientRow(
    identity, flagQueue, esi, sessionStartTs
  );
  const queue = computedCurrent ? [computedCurrent, ...MOCK_WAITING] : MOCK_WAITING;
  // Live row + 3 demo rows shown. The "+N more" count was previously
  // a fake "12 patients waiting" — replaced with an honest count of
  // visible rows + a "(demo waitlist)" subtitle so the queue panel
  // doesn't claim to represent a real waiting room.
  const visibleCount = queue.length;

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
          {visibleCount} {visibleCount === 1 ? "patient" : "patients"} · V.I.C.T.O.R. Active
        </p>
        <p style={{
          margin: "2px 0 0", color: "var(--vic-on-surface-variant)",
          fontSize: 9, fontWeight: 500, opacity: 0.6,
          fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}>
          live + demo waitlist
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 12px" }}>
        {queue.map((p) => {
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
                  display: "inline-flex", alignItems: "center", gap: 6,
                  color: LEVEL_COLOR[p.level], fontSize: 10, fontWeight: 700,
                  textTransform: "uppercase", letterSpacing: "0.18em",
                }}>
                  {p.isCurrent && (
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: "var(--vic-primary)",
                      animation: "ping 2s infinite",
                    }} />
                  )}
                  {p.level}
                  {p.isCurrent && (
                    <span style={{
                      fontSize: 8, color: "var(--vic-primary)",
                      letterSpacing: "0.1em",
                    }}>· LIVE</span>
                  )}
                  {p.mock && (
                    <span style={{
                      fontSize: 8,
                      color: "var(--vic-on-surface-variant)",
                      letterSpacing: "0.1em",
                      fontWeight: 600,
                      opacity: 0.7,
                    }}>· DEMO</span>
                  )}
                </span>
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
