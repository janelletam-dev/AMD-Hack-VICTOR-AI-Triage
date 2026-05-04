export function EpicTitleBar() {
  return (
    <>
      <div className="epic-titlebar">
        <span style={{ fontWeight: 600, letterSpacing: 0.2 }}>VICTOR</span>
        <span className="lozenge">Triage Workspace</span>
        <span style={{ opacity: 0.85 }}>— Mercy Hospital Springfield · ED Track 2</span>
        <span style={{ marginLeft: "auto", opacity: 0.85 }}>
          Dr. Reyes, A. · 4:01 PM · 05/04/2026
        </span>
        <span className="lozenge">Print</span>
        <span className="lozenge">Secure</span>
        <span className="lozenge">Log Out</span>
      </div>
      <div className="epic-menubar">
        <span>File</span><span>Edit</span><span>View</span><span>Patient</span>
        <span>Tools</span><span>Reports</span><span>Help</span>
        <span style={{ marginLeft: "auto", color: "#4a5b75" }}>Wksp · Triage · v1.4.2</span>
      </div>
    </>
  );
}

export function EpicPatientBanner({ patient, esi }) {
  const adj = esi?.victor_esi;
  const std = esi?.standard_esi;
  return (
    <div className="epic-banner">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div className="epic-banner-name">{patient.name}</div>
        <div style={{ fontSize: 11, color: "#4a5b75" }}>
          {patient.sex}, {patient.age} y.o. · DOB {patient.dob}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <span className="alert">Allergy: NKDA</span>
          {adj && adj < std && (
            <span style={{
              background: "var(--epic-flag-bg)", border: "1px solid var(--epic-flag-bd)",
              padding: "1px 6px", borderRadius: 2, fontWeight: 600, color: "#5a0e0a", fontSize: 11,
            }}>
              VICTOR Re-Triage: ESI {std} → {adj}
            </span>
          )}
        </div>
      </div>
      <div className="epic-banner-row">
        <div><span className="lbl">MRN</span>{patient.mrn}</div>
        <div><span className="lbl">CSN</span>{patient.csn}</div>
        <div><span className="lbl">Room/Bed</span>{patient.room}</div>
        <div><span className="lbl">Arrived</span>{patient.arrived}</div>
        <div><span className="lbl">Chief Complaint</span>{patient.cc}</div>
        <div><span className="lbl">Code</span>Full</div>
        <div><span className="lbl">PCP</span>Patel, R. MD</div>
        <div><span className="lbl">Insurance</span>BCBS PPO</div>
        <div><span className="lbl">Hgt/Wgt</span>{patient.hw}</div>
        <div><span className="lbl">Pregnancy</span>Negative</div>
        <div><span className="lbl">Isolation</span>None</div>
        <div><span className="lbl">FYI</span>None on file</div>
      </div>
    </div>
  );
}

export function EpicTabs() {
  const tabs = ["ED Manager", "ED Track Bd", "Triage", "Notes", "Flowsheets", "MAR", "Results", "Orders"];
  return (
    <div className="epic-tabs">
      {tabs.map((t) => (
        <div key={t} className={"tab" + (t === "Triage" ? " active" : "")}>{t}</div>
      ))}
    </div>
  );
}

function ToolIcon({ path }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#1a5fb4" strokeWidth="1.4">
      <path d={path} />
    </svg>
  );
}

function VictorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="2.4" fill="#0e7c86" />
      <circle cx="3" cy="3" r="1.4" fill="none" stroke="#0e7c86" />
      <circle cx="13" cy="3" r="1.4" fill="none" stroke="#0e7c86" />
      <circle cx="3" cy="13" r="1.4" fill="none" stroke="#0e7c86" />
      <circle cx="13" cy="13" r="1.4" fill="none" stroke="#0e7c86" />
      <line x1="8" y1="8" x2="3" y2="3" stroke="#0e7c86" strokeWidth="0.6" />
      <line x1="8" y1="8" x2="13" y2="3" stroke="#0e7c86" strokeWidth="0.6" />
      <line x1="8" y1="8" x2="3" y2="13" stroke="#0e7c86" strokeWidth="0.6" />
      <line x1="8" y1="8" x2="13" y2="13" stroke="#0e7c86" strokeWidth="0.6" />
    </svg>
  );
}

export function EpicToolbar({ onRunDemo, running }) {
  const Tool = ({ label, icon, active, onClick }) => (
    <div className={"epic-tool" + (active ? " active" : "")} onClick={onClick}>
      <div className="ico">{icon}</div>
      <div>{label}</div>
    </div>
  );
  return (
    <div className="epic-toolbar">
      <Tool label="Save" icon={<ToolIcon path="M3 3h8l2 2v8H3z M5 3v4h6V3 M5 13v-4h6v4" />} />
      <Tool label="Add Row" icon={<ToolIcon path="M3 4h10 M3 8h10 M3 12h10 M2 4l1-1 1 1" />} />
      <Tool label="LDA" icon={<ToolIcon path="M4 8a4 4 0 108 0 4 4 0 00-8 0 M8 4v8 M4 8h8" />} />
      <Tool label="Reg Doc" icon={<ToolIcon path="M4 2h6l2 2v10H4z M6 6h4 M6 9h4 M6 12h2" />} active />
      <Tool label="Graph" icon={<ToolIcon path="M2 13h12 M4 11l3-4 2 2 4-6" />} />
      <div className="epic-tool-sep" />
      <Tool label="VICTOR" icon={<VictorIcon />} />
      <Tool label="Concord." icon={<ToolIcon path="M3 8l3 3 7-7" />} />
      <Tool label="Biomark." icon={<ToolIcon path="M2 12c2-4 3-4 4 0s2 4 4 0 3-4 4 0" />} />
      <Tool label="Listen" icon={<ToolIcon path="M5 6v4 M8 4v8 M11 6v4" />} />
      <div className="epic-tool-sep" />
      <Tool label="Refresh" icon={<ToolIcon path="M13 4v3h-3 M3 12V9h3 M13 7a5 5 0 00-9-2 M3 9a5 5 0 009 2" />} />
      <Tool label="Legend" icon={<ToolIcon path="M3 4h10 M3 8h10 M3 12h6" />} />
      <Tool label="Cosign" icon={<ToolIcon path="M3 12c2-2 4-2 5 0 1-3 3-3 5 0" />} />
      <div className="epic-tool-sep" />
      <Tool
        label={running ? "Running" : "Run demo"}
        icon={
          <svg width="14" height="14" viewBox="0 0 16 16">
            <path d="M5 4l7 4-7 4z" fill={running ? "#94a3b8" : "#0e7c86"} />
          </svg>
        }
        active={!running}
        onClick={running ? undefined : onRunDemo}
      />
    </div>
  );
}

const RAIL_ITEMS = [
  ["Summary", "S"], ["Flowsheets", "F"], ["Manage Orders", "O"], ["Care Plan", "C"],
  ["Education", "E"], ["Notes", "N"], ["Results Review", "R"], ["Chart Review", "C"],
  ["History", "H"], ["Demographics", "D"], ["SnapShot", "S"], ["Review Flows", "R"],
  ["Order Review", "O"], ["Pathway Rev.", "P"], ["VICTOR Triage", "V"],
];

export function EpicRail() {
  return (
    <div className="epic-rail">
      {RAIL_ITEMS.map(([label, glyph]) => {
        const active = label === "VICTOR Triage";
        return (
          <div key={label} className={"item" + (active ? " active" : "")}>
            <div className="ico">{glyph}</div>
            <div>{label}</div>
          </div>
        );
      })}
    </div>
  );
}

export function EpicStatusBar() {
  return (
    <div className="epic-statusbar">
      <span style={{ fontWeight: 600 }}>Dr. Reyes, A.</span>
      <span>·</span>
      <span>ED Track 2</span>
      <span>·</span>
      <span style={{ color: "#1f4d22" }}>● VICTOR connected</span>
      <span style={{ marginLeft: "auto" }}>v1.4.2 · build 2026.05.04</span>
    </div>
  );
}
