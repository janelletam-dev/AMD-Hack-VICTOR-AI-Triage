export default function SOAPCard({ soap, vitals, demographics }) {
  return (
    <section style={{
      background: "var(--vic-bg-low)",
      borderRadius: 16,
      border: "1px solid rgba(69, 70, 77, 0.15)",
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "18px 28px", background: "var(--vic-bg-mid)",
        borderBottom: "1px solid rgba(69, 70, 77, 0.18)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--vic-primary)", fontSize: 18 }}>📋</span>
          <h3 style={{
            margin: 0, fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 700, fontSize: 16, letterSpacing: "-0.01em",
            color: "var(--vic-on-surface)",
          }}>
            S.C.R.I.B.E. Automated SOAP Note
          </h3>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, color: "var(--vic-on-surface-variant)",
          textTransform: "uppercase", letterSpacing: "0.18em",
        }}>
          {soap?.ready ? "Ready for Review" : "Streaming…"}
        </span>
      </div>

      {demographics && (
        <div style={{
          padding: "12px 28px", display: "flex", gap: 24, flexWrap: "wrap",
          background: "var(--vic-bg)", borderBottom: "1px solid rgba(69, 70, 77, 0.12)",
          fontSize: 12, color: "var(--vic-on-surface-variant)",
        }}>
          <Demo label="Demographics" value={demographics.demo} accent="var(--vic-primary)" />
          <Demo label="Presenting Symptom" value={demographics.symptom} accent="var(--vic-primary)" />
          <Demo label="Risk Factor" value={demographics.risk} accent="var(--vic-tertiary)" />
        </div>
      )}

      <div style={{
        padding: 28, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28,
      }}>
        <Section label="Subjective" border="rgba(47, 217, 244, 0.3)">
          <p style={panelText}>{soap?.subjective || empty}</p>
        </Section>

        <Section label="Assessment" border="var(--vic-error)" bg="rgba(255, 180, 171, 0.05)">
          <p style={panelText}>{soap?.assessment || empty}</p>
        </Section>

        <Section label="Objective">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {(vitals || DEFAULT_VITALS).map((v) => (
              <Vital key={v.label} {...v} />
            ))}
          </div>
        </Section>

        <Section label="Plan">
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            {(soap?.plan || DEFAULT_PLAN).map((p, i) => (
              <li key={i} style={{
                display: "flex", alignItems: "center", gap: 10,
                fontSize: 13, color: "var(--vic-on-surface)",
              }}>
                <span style={{ color: "var(--vic-primary)" }}>✓</span>{p}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </section>
  );
}

const empty = "Awaiting input from the patient interview…";

const DEFAULT_VITALS = [
  { label: "BP",         value: "142/88",  flag: "High" },
  { label: "Heart Rate", value: "94 BPM" },
  { label: "O2 Sat",     value: "98%" },
  { label: "Temp",       value: "98.6°F" },
];

const DEFAULT_PLAN = [
  "Immediate 12-lead EKG",
  "Stat Troponin level and CBC",
  "Bedside Cardiology Consult (Level 1)",
];

const panelText = {
  margin: 0, fontSize: 13, lineHeight: 1.65,
  color: "var(--vic-on-surface)",
  background: "rgba(46, 52, 71, 0.4)",
  padding: 14, borderRadius: 8,
};

function Section({ label, children, border, bg }) {
  return (
    <div>
      <h4 style={{
        margin: "0 0 12px",
        color: "var(--vic-primary)", fontSize: 11, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: "0.2em",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--vic-primary)" }} />
        {label}
      </h4>
      <div style={{
        ...(border ? { borderLeft: `2px solid ${border}` } : {}),
        ...(bg ? { background: bg, padding: 14, borderRadius: 8 } : {}),
      }}>
        {children}
      </div>
    </div>
  );
}

function Vital({ label, value, flag }) {
  return (
    <div style={{
      background: "rgba(46, 52, 71, 0.4)",
      border: "1px solid rgba(69, 70, 77, 0.15)",
      borderRadius: 8, padding: 12,
    }}>
      <p style={{
        margin: 0, fontSize: 10, color: "var(--vic-on-surface-variant)",
        textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500,
      }}>{label}</p>
      <p style={{
        margin: "4px 0 0", fontFamily: "'Space Grotesk', sans-serif",
        fontWeight: 700, fontSize: 18, color: "var(--vic-on-surface)",
      }}>
        {value}{flag && <span style={{ fontSize: 11, color: "var(--vic-tertiary)", marginLeft: 6 }}>{flag}</span>}
      </p>
    </div>
  );
}

function Demo({ label, value, accent }) {
  return (
    <div>
      <p style={{
        margin: 0, fontSize: 9, color: "var(--vic-on-surface-variant)",
        textTransform: "uppercase", letterSpacing: "0.2em", fontWeight: 700,
      }}>{label}</p>
      <p style={{ margin: "2px 0 0", fontSize: 13, color: accent, fontWeight: 500 }}>{value}</p>
    </div>
  );
}
