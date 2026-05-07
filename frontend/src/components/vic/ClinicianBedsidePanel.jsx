import { useState, useEffect, useCallback } from "react";
import { HTTP_BASE } from "../../lib/backend-urls.js";

// Bedside collaboration panel — the clinician working alongside V.I.C.T.O.R.
// to arrive at the SOAP. The kiosk captures voice triage; this panel captures
// what only the bedside clinician can: vitals, physical exam, additional
// history they elicited in person, working differential, plan modifications.
//
// On submit, posts to /api/clinician/addendum/{room} which updates the session
// log AND triggers SCRIBE to recompose the SOAP with the new context. The
// clinician sees their inputs flow into the chart in real time — V.I.C.T.O.R.
// + clinician arriving at the SOAP collaboratively, which is the actual
// product story for an ED partner pilot.
export default function ClinicianBedsidePanel({ room = "demo", onUpdate }) {
  const [vitals, setVitals] = useState({
    bp: "", hr: "", rr: "", spo2: "", temp: "", pain: "",
  });
  const [physicalExam, setPhysicalExam] = useState("");
  const [additionalHistory, setAdditionalHistory] = useState("");
  const [bedsideAssessment, setBedsideAssessment] = useState("");
  const [planAddendum, setPlanAddendum] = useState("");
  const [clinician, setClinician] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  // Pre-load any existing addendum so a clinician returning to the chart
  // sees what they already contributed (and can edit) rather than a blank
  // form. GET /addendum/{room} returns {present: false} if none.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${HTTP_BASE}/api/clinician/addendum/${room}`);
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled || !data.present) return;
        if (data.vitals) setVitals(v => ({ ...v, ...data.vitals }));
        if (data.physical_exam) setPhysicalExam(data.physical_exam);
        if (data.additional_history) setAdditionalHistory(data.additional_history);
        if (data.bedside_assessment) setBedsideAssessment(data.bedside_assessment);
        if (Array.isArray(data.plan_addendum)) setPlanAddendum(data.plan_addendum.join("\n"));
        if (data.clinician) setClinician(data.clinician);
        if (data.updated_at) setLastSavedAt(data.updated_at * 1000);
      } catch { /* network blip — leave blank */ }
    })();
    return () => { cancelled = true; };
  }, [room]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const planList = planAddendum
        .split("\n")
        .map(s => s.trim())
        .filter(Boolean);
      const body = {
        vitals: Object.values(vitals).some(v => v && v.trim()) ? vitals : null,
        physical_exam: physicalExam.trim() || null,
        additional_history: additionalHistory.trim() || null,
        bedside_assessment: bedsideAssessment.trim() || null,
        plan_addendum: planList.length ? planList : null,
        clinician: clinician.trim() || null,
      };
      const r = await fetch(`${HTTP_BASE}/api/clinician/addendum/${room}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`server returned ${r.status}`);
      const data = await r.json();
      setLastSavedAt(Date.now());
      if (onUpdate && data.soap) onUpdate(data.soap);
    } catch (e) {
      setError(e.message || "Save failed");
    } finally {
      setSubmitting(false);
    }
  }, [vitals, physicalExam, additionalHistory, bedsideAssessment, planAddendum, clinician, room, onUpdate]);

  const lastSavedLabel = lastSavedAt
    ? new Date(lastSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <section className="vic-glass" style={{
      padding: 20, borderRadius: 16,
      border: "1px solid rgba(120, 200, 160, 0.25)",
      display: "flex", flexDirection: "column", gap: 14,
      background: "rgba(120, 200, 160, 0.02)",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexWrap: "wrap", gap: 12,
      }}>
        <div>
          <div style={{
            fontSize: 10, fontWeight: 700,
            color: "var(--vic-aligned)",
            textTransform: "uppercase", letterSpacing: "0.2em",
          }}>
            Clinician Bedside · collaborate with V.I.C.T.O.R.
          </div>
          <div style={{
            fontSize: 12, color: "var(--vic-on-surface-variant)",
            marginTop: 4, lineHeight: 1.5,
          }}>
            Add what the kiosk can't observe — vitals, exam findings,
            additional history, working differential, plan modifications.
            SOAP recomputes when you save.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {lastSavedLabel && (
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10, color: "var(--vic-aligned)",
              letterSpacing: "0.06em",
            }}>
              saved {lastSavedLabel}
            </span>
          )}
          <button
            onClick={() => setCollapsed(c => !c)}
            style={{
              background: "transparent",
              border: "1px solid rgba(120, 200, 160, 0.3)",
              borderRadius: 6, padding: "4px 10px", cursor: "pointer",
              color: "var(--vic-aligned)", fontSize: 10,
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: "0.1em", textTransform: "uppercase",
            }}
          >
            {collapsed ? "Expand" : "Collapse"}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Vitals — six discrete inputs in a tight grid */}
          <FieldGroup label="Vital signs">
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
              gap: 8,
            }}>
              <VitalInput label="BP"   placeholder="142/88" value={vitals.bp}   onChange={v => setVitals(s => ({...s, bp:   v}))} />
              <VitalInput label="HR"   placeholder="94"     value={vitals.hr}   onChange={v => setVitals(s => ({...s, hr:   v}))} />
              <VitalInput label="RR"   placeholder="18"     value={vitals.rr}   onChange={v => setVitals(s => ({...s, rr:   v}))} />
              <VitalInput label="SpO2" placeholder="96"     value={vitals.spo2} onChange={v => setVitals(s => ({...s, spo2: v}))} suffix="%" />
              <VitalInput label="Temp" placeholder="98.4"   value={vitals.temp} onChange={v => setVitals(s => ({...s, temp: v}))} suffix="°F" />
              <VitalInput label="Pain" placeholder="6"      value={vitals.pain} onChange={v => setVitals(s => ({...s, pain: v}))} suffix="/10" />
            </div>
          </FieldGroup>

          <FieldGroup label="Physical examination">
            <BedsideTextarea
              value={physicalExam} onChange={setPhysicalExam}
              placeholder="General: alert, anxious-appearing, diaphoretic. Cardiac: RRR, no MRG. Resp: CTAB. Abd: soft, NT/ND. Neuro: A&Ox4, no focal deficits."
            />
          </FieldGroup>

          <FieldGroup label="Additional history (elicited at bedside)">
            <BedsideTextarea
              value={additionalHistory} onChange={setAdditionalHistory}
              placeholder="Anything the kiosk missed — exposure history, recent meds taken, social context, etc."
              rows={2}
            />
          </FieldGroup>

          <FieldGroup label="Bedside assessment (working differential)">
            <BedsideTextarea
              value={bedsideAssessment} onChange={setBedsideAssessment}
              placeholder="Clinician's own working differential — sits alongside V.I.C.T.O.R.'s assessment in the chart."
              rows={2}
            />
          </FieldGroup>

          <FieldGroup label="Plan additions (one per line)">
            <BedsideTextarea
              value={planAddendum} onChange={setPlanAddendum}
              placeholder={"ASA 324mg PO given at 14:48\nCardiology paged at 14:52\nFamily updated"}
              rows={3}
              monospace
            />
          </FieldGroup>

          <div style={{
            display: "flex", justifyContent: "space-between",
            alignItems: "center", flexWrap: "wrap", gap: 12,
          }}>
            <input
              type="text"
              value={clinician}
              onChange={e => setClinician(e.target.value)}
              placeholder="Your name (optional, e.g., Dr. Reyes)"
              style={{
                flex: 1, minWidth: 200,
                padding: "8px 12px", borderRadius: 8,
                background: "rgba(12, 19, 36, 0.55)",
                border: "1px solid rgba(120, 200, 160, 0.2)",
                color: "var(--vic-on-surface)",
                fontFamily: "'Inter', sans-serif", fontSize: 13,
                outline: "none",
              }}
            />
            <button
              onClick={submit}
              disabled={submitting}
              style={{
                padding: "10px 22px", borderRadius: 10, border: "none",
                background: submitting
                  ? "rgba(120, 200, 160, 0.4)"
                  : "linear-gradient(to right, var(--vic-aligned), var(--vic-aligned-deep))",
                color: "#0c1324",
                fontWeight: 700, fontSize: 13,
                cursor: submitting ? "wait" : "pointer",
                letterSpacing: "0.02em",
                boxShadow: submitting ? "none" : "0 6px 20px rgba(120, 200, 160, 0.25)",
              }}
            >
              {submitting ? "Updating chart…" : "↓ Push to chart"}
            </button>
          </div>

          {error && (
            <div style={{
              padding: "8px 12px", borderRadius: 8,
              background: "rgba(255, 100, 100, 0.08)",
              border: "1px solid rgba(255, 100, 100, 0.3)",
              color: "var(--vic-error)", fontSize: 12,
            }}>
              {error}. Try again — your inputs above are preserved.
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FieldGroup({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10, fontWeight: 700, letterSpacing: "0.18em",
        textTransform: "uppercase", color: "rgba(120, 200, 160, 0.85)",
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function VitalInput({ label, placeholder, value, onChange, suffix }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 2,
      padding: "6px 10px", borderRadius: 8,
      background: "rgba(12, 19, 36, 0.55)",
      border: "1px solid rgba(120, 200, 160, 0.18)",
    }}>
      <span style={{
        fontSize: 9, color: "var(--vic-on-surface-variant)",
        textTransform: "uppercase", letterSpacing: "0.12em",
        fontWeight: 700,
      }}>
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1, minWidth: 0,
            background: "transparent", border: "none", outline: "none",
            color: "var(--vic-on-surface)",
            fontFamily: "'Space Grotesk', sans-serif",
            fontSize: 16, fontWeight: 600,
            padding: 0,
          }}
        />
        {suffix && (
          <span style={{
            fontSize: 11, color: "var(--vic-on-surface-variant)",
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function BedsideTextarea({ value, onChange, placeholder, rows = 2, monospace = false }) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={{
        width: "100%", padding: "10px 12px", borderRadius: 8,
        background: "rgba(12, 19, 36, 0.55)",
        border: "1px solid rgba(120, 200, 160, 0.18)",
        color: "var(--vic-on-surface)",
        fontFamily: monospace ? "'JetBrains Mono', monospace" : "'Inter', sans-serif",
        fontSize: 13, lineHeight: 1.5,
        outline: "none", resize: "vertical",
        boxSizing: "border-box",
      }}
    />
  );
}
