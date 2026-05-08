export default function SOAPCard({
  soap, vitals, demographics, clinicianAddendum, esi, flags,
  onPushToEpic, pushing, pushed,
}) {
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

  const std = esi?.standard_esi || 0;
  const adj = esi?.victor_esi || 0;
  const adjusted = adj && std && adj < std;
  const flagCount = Array.isArray(flags) ? flags.length : 0;
  const showScoreSummary = !!(std || adj || flagCount);

  return (
    <section className="vic-glass" style={{
      padding: 22,
      borderRadius: 16,
      border: `1px solid ${coAuthored ? "rgba(120, 200, 160, 0.25)" : "rgba(47, 217, 244, 0.15)"}`,
    }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
          textTransform: "uppercase", letterSpacing: "0.2em",
          color: "rgba(47, 217, 244, 0.8)", marginBottom: 8,
        }}>
          Triage SOAP Note · S.C.R.I.B.E.
        </div>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12, flexWrap: "wrap",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h3 style={{
              fontSize: 22, fontWeight: 600, margin: 0,
              fontFamily: "'Space Grotesk', sans-serif",
              letterSpacing: "-0.02em",
              color: "var(--vic-on-surface)",
            }}>
              Automated SOAP Note
            </h3>
            {coAuthored && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "3px 10px", borderRadius: 999,
                background: "rgba(120, 200, 160, 0.12)",
                border: "1px solid rgba(120, 200, 160, 0.35)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase",
                color: "var(--vic-aligned)", fontWeight: 700,
              }}>
                Co-authored · V.I.C.T.O.R. + {clinicianName || "Clinician"}
              </span>
            )}
          </div>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10, fontWeight: 700,
            color: "var(--vic-on-surface-variant)",
            textTransform: "uppercase", letterSpacing: "0.18em",
          }}>
            {soap?.ready ? "Ready for Review" : "Streaming…"}
          </span>
        </div>
      </div>

      {showScoreSummary && (
        <div style={{
          padding: "18px 20px",
          marginBottom: 16,
          borderRadius: 12,
          border: "1px solid rgba(47, 217, 244, 0.18)",
          background: "rgba(47, 217, 244, 0.04)",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr 1fr",
            alignItems: "center", gap: 20,
          }}>
            <ScoreBlock label="Standard ESI" value={std || "—"} />
            <Arrow adjusted={adjusted} />
            <ScoreBlock
              label="V.I.C.T.O.R.-adjusted ESI"
              value={adj || "—"}
              highlight={adjusted}
            />
            <ScoreBlock
              label="Concordance flags"
              value={flagCount}
              highlight={flagCount > 0}
            />
          </div>
        </div>
      )}

      {demographics && (demographics.demo || demographics.symptom || demographics.risk) && (
        <div style={{
          padding: "12px 16px",
          marginBottom: 16,
          borderRadius: 10,
          border: "1px solid rgba(69, 70, 77, 0.18)",
          background: "rgba(46, 52, 71, 0.25)",
          display: "flex", gap: 24, flexWrap: "wrap",
          fontSize: 12, color: "var(--vic-on-surface-variant)",
        }}>
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
        display: "flex", flexDirection: "column", gap: 22,
      }}>
        <Section label="Subjective" border="rgba(47, 217, 244, 0.3)">
          <SubjectiveText text={soap?.subjective} />
        </Section>

        <Section label="Assessment" border="var(--vic-error)" bg="rgba(255, 180, 171, 0.05)">
          <p style={panelText}>{soap?.assessment || empty}</p>
        </Section>

        <Section label="Objective" border="rgba(47, 217, 244, 0.3)">
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

        <Section label="Plan" border="rgba(47, 217, 244, 0.3)">
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            {(soap?.plan || DEFAULT_PLAN).map((p, i) => (
              <li key={i} style={{
                display: "flex", alignItems: "flex-start", gap: 10,
                fontSize: 13, lineHeight: 1.55,
                color: "var(--vic-on-surface)",
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

      {onPushToEpic && (
        <div style={{
          marginTop: 16, paddingTop: 14,
          borderTop: "1px solid rgba(69, 70, 77, 0.3)",
          display: "flex", justifyContent: "flex-end",
          alignItems: "center", gap: 12, flexWrap: "wrap",
        }}>
          <span style={{
            fontSize: 11, color: "var(--vic-on-surface-variant)",
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: "0.06em",
          }}>
            Push the chart that builds the FHIR DocumentReference →
          </span>
          <button
            type="button"
            onClick={onPushToEpic}
            disabled={pushing || pushed || !soap?.ready}
            style={{
              padding: "10px 18px", borderRadius: 10, border: "none",
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 700, fontSize: 13,
              letterSpacing: "-0.01em",
              cursor: (pushing || pushed || !soap?.ready) ? "not-allowed" : "pointer",
              background: pushed
                ? "linear-gradient(to right, #1f7a3a, #2ea35a)"
                : (soap?.ready ? "linear-gradient(to right, var(--vic-primary), #008ea1)" : "var(--vic-bg-highest)"),
              color: pushed ? "#9be7b1" : (soap?.ready ? "var(--vic-on-primary)" : "var(--vic-on-surface-variant)"),
              boxShadow: (soap?.ready && !pushed && !pushing) ? "0 6px 18px rgba(47, 217, 244, 0.25)" : "none",
            }}
          >
            {pushed
              ? "✓ Approved & pushed to Epic"
              : pushing
                ? "Pushing to Epic…"
                : "☁ Approve & Push to Epic"}
          </button>
        </div>
      )}

      <div style={{
        marginTop: 18, paddingTop: 14,
        borderTop: "1px solid rgba(69, 70, 77, 0.3)",
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
        margin: "0 0 10px",
        color: "var(--vic-primary)",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: "0.18em",
      }}>
        {label}
      </h4>
      <div style={{
        ...(border ? { borderLeft: `2px solid ${border}`, paddingLeft: 12 } : {}),
        ...(bg ? { background: bg, padding: 14, borderRadius: 8 } : {}),
      }}>
        {children}
      </div>
    </div>
  );
}

function ScoreBlock({ label, value, highlight }) {
  return (
    <div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
        letterSpacing: "0.18em", textTransform: "uppercase",
        color: "var(--vic-on-surface-variant)", marginBottom: 6,
      }}>{label}</div>
      <div style={{
        fontSize: 32, fontWeight: 600,
        fontFamily: "'Space Grotesk', sans-serif",
        letterSpacing: "-0.02em",
        color: highlight ? "var(--vic-error)" : "var(--vic-on-surface)",
      }}>{value}</div>
    </div>
  );
}

function Arrow({ adjusted }) {
  return (
    <div style={{
      color: adjusted ? "var(--vic-error)" : "var(--vic-on-surface-variant)",
      fontSize: 24, fontWeight: 700,
      textAlign: "center",
    }}>→</div>
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
