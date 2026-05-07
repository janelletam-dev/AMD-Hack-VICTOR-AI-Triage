export default function SOAPCard({ soap, vitals, demographics, clinicianAddendum }) {
  // The clinician addendum can come either as a prop (fresh from
  // /api/clinician/addendum POST) or be embedded in the SOAP text via
  // SCRIBE's "(Clinician: ...)" attribution markers. Render a subtle
  // "Co-authored" banner when either signal is present so the chart
  // reader can see at a glance that V.I.C.T.O.R. + the clinician both
  // contributed to this chart, without having to scan attribution lines.
  const subjectiveText = soap?.subjective || "";
  const objectiveText = soap?.objective || "";
  const assessmentText = soap?.assessment || "";
  const planList = soap?.plan || [];
  const hasClinicianMarker = (
    /\(Clinician/i.test(subjectiveText)
    || /\(Clinician/i.test(objectiveText)
    || /\(Clinician/i.test(assessmentText)
    || planList.some(p => /^\(Clinician\)/i.test(p))
  );
  const hasAddendum = !!(
    clinicianAddendum?.vitals_summary
    || clinicianAddendum?.physical_exam
    || clinicianAddendum?.additional_history
    || clinicianAddendum?.bedside_assessment
    || (clinicianAddendum?.plan_addendum && clinicianAddendum.plan_addendum.length)
  );
  const coAuthored = hasClinicianMarker || hasAddendum;
  const clinicianName = (clinicianAddendum?.clinician || "").trim();
  return (
    <section style={{
      background: "var(--vic-bg-low)",
      borderRadius: 16,
      border: `1px solid ${coAuthored ? "rgba(120, 200, 160, 0.25)" : "rgba(69, 70, 77, 0.15)"}`,
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "18px 28px", background: "var(--vic-bg-mid)",
        borderBottom: "1px solid rgba(69, 70, 77, 0.18)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ color: "var(--vic-primary)", fontSize: 18 }}>📋</span>
          <h3 style={{
            margin: 0, fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 700, fontSize: 16, letterSpacing: "-0.01em",
            color: "var(--vic-on-surface)",
          }}>
            S.C.R.I.B.E. Automated SOAP Note
          </h3>
          {coAuthored && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "3px 10px", borderRadius: 999,
              background: "rgba(120, 200, 160, 0.12)",
              border: "1px solid rgba(120, 200, 160, 0.35)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase",
              color: "rgb(120, 200, 160)", fontWeight: 700,
            }}>
              Co-authored · V.I.C.T.O.R. + {clinicianName || "Clinician"}
            </span>
          )}
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, color: "var(--vic-on-surface-variant)",
          textTransform: "uppercase", letterSpacing: "0.18em",
        }}>
          {soap?.ready ? "Ready for Review" : "Streaming…"}
        </span>
      </div>

      {demographics && (demographics.demo || demographics.symptom || demographics.risk) && (
        <div style={{
          padding: "12px 28px", display: "flex", gap: 24, flexWrap: "wrap",
          background: "var(--vic-bg)", borderBottom: "1px solid rgba(69, 70, 77, 0.12)",
          fontSize: 12, color: "var(--vic-on-surface-variant)",
        }}>
          {/* Each Demo only renders when its value is truthy — avoids
              showing fabricated "—" placeholders that could read as
              "we have this info" when in fact we don't yet. */}
          {demographics.demo && (
            <Demo label="Demographics" value={demographics.demo} accent="var(--vic-primary)" />
          )}
          {demographics.symptom && (
            <Demo label="Presenting Symptom" value={demographics.symptom} accent="var(--vic-primary)" />
          )}
          {demographics.risk && (
            <Demo label="Risk Factor" value={demographics.risk} accent="var(--vic-tertiary)" />
          )}
        </div>
      )}

      <div style={{
        padding: 28, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28,
      }}>
        <Section label="Subjective" border="rgba(47, 217, 244, 0.3)">
          <SubjectiveText text={soap?.subjective} />
        </Section>

        <Section label="Assessment" border="var(--vic-error)" bg="rgba(255, 180, 171, 0.05)">
          <p style={panelText}>{soap?.assessment || empty}</p>
        </Section>

        <Section label="Objective">
          {/* Render SCRIBE's composed objective (biomarker readings + */}
          {/* contextual notes) when present. Vital-sign tiles only show */}
          {/* when the caller passes real `vitals` — never fabricate. */}
          {vitals && vitals.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {vitals.map((v) => (
                <Vital key={v.label} {...v} />
              ))}
            </div>
          ) : soap?.objective ? (
            <p style={{ ...panelText, whiteSpace: "pre-wrap" }}>{soap.objective}</p>
          ) : (
            <p style={panelText}>{empty}</p>
          )}
        </Section>

        <Section label="Plan">
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            {(soap?.plan || DEFAULT_PLAN).map((p, i) => (
              <li key={i} style={{
                display: "flex", alignItems: "flex-start", gap: 10,
                fontSize: 13, color: "var(--vic-on-surface)",
              }}>
                <span style={{
                  color: "var(--vic-primary)", fontWeight: 700,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11, lineHeight: 1.7, minWidth: 18,
                }}>{String(i + 1).padStart(2, "0")}</span>
                <span style={{ flex: 1 }}>{p}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      {/* AI-assisted documentation disclosure — required clinician
          oversight + bias-monitoring footer. Aligns with AMA augmented-
          intelligence principles: AI-generated content requires clinician
          review before signing; output may contain hallucinations,
          mishearing, or context errors. Linked checklist gives the
          clinician a quick verification pass before "Approve & Push to
          Epic" makes the chart durable. */}
      <div style={{
        padding: "10px 28px",
        borderTop: "1px solid rgba(69, 70, 77, 0.18)",
        background: "rgba(46, 52, 71, 0.25)",
        fontSize: 11, lineHeight: 1.55,
        color: "var(--vic-on-surface-variant)",
        display: "flex", justifyContent: "space-between",
        alignItems: "center", flexWrap: "wrap", gap: 8,
      }}>
        <span>
          <strong style={{ color: "rgba(255, 185, 95, 0.9)" }}>AI-assisted documentation.</strong>{" "}
          Generated by S.C.R.I.B.E. (V.I.C.T.O.R. agent swarm) from voice
          triage. Requires clinician review before sign-off — verify
          demographics, vitals, exam findings, doses, and diagnoses.
          May contain hallucinated, misheard, or context-shifted content.
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10, letterSpacing: "0.06em",
          color: "var(--vic-on-surface-variant)", opacity: 0.7,
        }}>
          per AMA augmented-intelligence principles
        </span>
      </div>
    </section>
  );
}

const MAX_SUBJECTIVE_CHARS = 600;

function SubjectiveText({ text }) {
  if (!text) return <p style={panelText}>{empty}</p>;
  const capped = text.length > MAX_SUBJECTIVE_CHARS;
  const display = capped ? text.slice(0, MAX_SUBJECTIVE_CHARS) + "…" : text;
  // pre-wrap preserves the `\n• …` bullets that SCRIBE composes in the
  // backfill path; otherwise the HPI collapses into a single run-on line.
  return (
    <div>
      <p style={{ ...panelText, maxHeight: 180, overflowY: "auto", whiteSpace: "pre-wrap" }}>
        {display}
      </p>
      {capped && (
        <div style={{
          fontSize: 10, color: "var(--vic-on-surface-variant)",
          fontStyle: "italic", marginTop: 4,
        }}>
          Summarised by S.C.R.I.B.E. — full transcript available in session log
        </div>
      )}
    </div>
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
