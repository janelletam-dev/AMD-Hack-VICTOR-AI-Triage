export function EpicConcordanceSection({ flag }) {
  return (
    <div className="epic-section">
      <div className="epic-band">
        <span>VICTOR Concordance Flag</span>
        <span className="meta">
          {flag ? `Tier ${flag.tier} · ${flag.agent || "M.E.R.C.E.D."}` : "Awaiting evaluation"}
        </span>
      </div>
      {!flag ? (
        <div style={{ padding: "8px 10px", color: "#4a5b75", fontStyle: "italic" }}>
          No concordance discrepancy detected. Standard ESI in effect.
        </div>
      ) : (
        <>
          <div className="epic-flag-bar">
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              Atypical presentation — re-triage recommended
            </div>
            <div>{flag.gloss}</div>
          </div>
          <div className="epic-row">
            <div className="k">Trigger phrase</div>
            <div className="v" style={{ fontStyle: "italic" }}>"{flag.trigger_phrase}"</div>
          </div>
          <div className="epic-row">
            <div className="k">Biomarker signal</div>
            <div className="v">{flag.biomarker_signal}</div>
          </div>
          <div className="epic-row">
            <div className="k">Evidence basis</div>
            <div className="v">
              MIMIC-IV female CVD cohort · n=2,418 ·
              <span style={{ color: "var(--epic-link)", marginLeft: 6 }}>view cohort</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function EpicESISection({ esi }) {
  const std = esi?.standard_esi ?? "—";
  const adj = esi?.victor_esi ?? "—";
  const changed = esi && adj !== std;
  return (
    <div className="epic-section">
      <div className="epic-band">
        <span>ESI Acuity</span>
        <span className="meta">Standard vs VICTOR-adjusted</span>
      </div>
      <div className="epic-row">
        <div className="k">Standard ESI</div>
        <div className="v">
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 14, fontWeight: 600 }}>{std}</span>
          <span style={{ color: "#4a5b75", marginLeft: 8 }}>(RN triage assessment)</span>
        </div>
      </div>
      <div className="epic-row" style={{ background: changed ? "#fff7d6" : undefined }}>
        <div className="k" style={{ background: changed ? "#fff7d6" : undefined }}>VICTOR-adjusted ESI</div>
        <div className="v">
          <span style={{
            fontFamily: "'JetBrains Mono',monospace", fontSize: 14, fontWeight: 700,
            color: changed ? "#b3261e" : "#1a2332"
          }}>{adj}</span>
          {changed && <span style={{ marginLeft: 8, color: "#b3261e", fontWeight: 600 }}>↑ Escalate</span>}
        </div>
      </div>
      <div className="epic-row">
        <div className="k">Reason</div>
        <div className="v" style={{
          color: esi ? "#1a2332" : "#4a5b75",
          fontStyle: esi ? "normal" : "italic"
        }}>
          {esi?.adjustment_reason || "Awaiting evidence — score updates as concordance signals arrive."}
        </div>
      </div>
    </div>
  );
}

function EpicBar({ label, value, group }) {
  const pct = Math.round((value || 0) * 100);
  const high = pct >= 60;
  return (
    <div className="epic-row">
      <div className="k">
        <span style={{
          color: "#4a5b75", fontSize: 10.5, marginRight: 6,
          textTransform: "uppercase", letterSpacing: ".06em"
        }}>
          {group}
        </span>
        {label}
      </div>
      <div className="v" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          flex: 1, height: 10, background: "#eef2f7",
          border: "1px solid #cdd9e6", borderRadius: 2, overflow: "hidden", maxWidth: 180,
        }}>
          <div style={{
            height: "100%", width: pct + "%",
            background: high
              ? "linear-gradient(to bottom, #ec8a82, #b3261e)"
              : "linear-gradient(to bottom, #6dbcc4, #0e7c86)",
            transition: "width .4s",
          }} />
        </div>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, minWidth: 36 }}>
          {value == null ? "—" : value.toFixed(2)}
        </span>
        {high && <span style={{ color: "#b3261e", fontWeight: 600, fontSize: 11 }}>HIGH</span>}
      </div>
    </div>
  );
}

export function EpicBiomarkersSection({ data }) {
  // Field names are canonical thymia Helios fields — see
  // docs.thymia.ai/helios/interpreting-results.
  const h = data?.helios || {};
  return (
    <div className="epic-section">
      <div className="epic-band">
        <span>Voice Biomarkers · Thymia Helios</span>
        <span className="meta">Acoustic biomarker analysis · ≥15s validated</span>
      </div>
      {!data ? (
        <div style={{ padding: "8px 10px", color: "#4a5b75", fontStyle: "italic" }}>
          Awaiting voice sample…
        </div>
      ) : (
        <>
          <EpicBar group="Helios" label="Mental Strain" value={h.mentalStrain} />
          <EpicBar group="Helios" label="Stress" value={h.stress} />
          <EpicBar group="Helios" label="Distress" value={h.distress} />
          <EpicBar group="Helios" label="Exhaustion" value={h.exhaustion} />
          <EpicBar group="Helios" label="Sleep Propensity" value={h.sleepPropensity} />
          <EpicBar group="Helios" label="Low Self-Esteem" value={h.lowSelfEsteem} />
        </>
      )}
    </div>
  );
}

export function EpicTranscriptSection({ lines }) {
  return (
    <div className="epic-section">
      <div className="epic-band">
        <span>Patient Interview · Live Transcript</span>
        <span className="meta">J.A.C.K.I.E. · Deepgram</span>
      </div>
      <div style={{
        padding: "6px 10px", maxHeight: 140, overflow: "auto",
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.65,
      }}>
        {lines.length === 0 ? (
          <div style={{ color: "#4a5b75", fontStyle: "italic", fontFamily: "'Segoe UI',sans-serif" }}>
            Awaiting audio…
          </div>
        ) : (
          lines.map((l, i) => (
            <div key={i}>
              <span style={{
                background: "#e7eef6", color: "#4a5b75",
                padding: "0 4px", marginRight: 6, borderRadius: 2, fontSize: 10,
              }}>{l.language || "—"}</span>
              {l.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function EpicSOAPSection({ note }) {
  const sections = [
    ["S", "Subjective", note?.subjective],
    ["O", "Objective", note?.objective],
    ["A", "Assessment", note?.assessment],
    ["P", "Plan", note?.plan],
  ];
  return (
    <div className="epic-section">
      <div className="epic-band">
        <span>SOAP Note · S.C.R.I.B.E.</span>
        <span className="meta">Draft — pending clinician cosign</span>
      </div>
      {sections.map(([k, name, body]) => {
        // Plan is an array of bullets; S/O/A may contain "\n• …" lines
        // when SCRIBE composes a structured HPI. Render arrays as a real
        // list and preserve newlines on string bodies via pre-wrap.
        const isList = Array.isArray(body);
        const hasContent = isList ? body.length > 0 : !!(body && String(body).trim());
        return (
          <div key={k} className="epic-row">
            <div className="k">
              <span style={{
                display: "inline-block", width: 16, textAlign: "center", marginRight: 6,
                background: "#e3f2f3", color: "#0e7c86", fontWeight: 700, borderRadius: 2,
                fontFamily: "'JetBrains Mono',monospace",
              }}>{k}</span>
              {name}
            </div>
            <div className="v" style={{
              color: hasContent ? "#1a2332" : "#4a5b75",
              fontStyle: hasContent ? "normal" : "italic",
              whiteSpace: isList ? "normal" : "pre-wrap",
            }}>
              {isList ? (
                hasContent ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {body.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                ) : "—"
              ) : (body || "—")}
            </div>
          </div>
        );
      })}
    </div>
  );
}
