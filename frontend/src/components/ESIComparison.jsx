export default function ESIComparison({ esi, nurseEsi }) {
  const std = esi?.standard_esi ?? "—";
  const adj = esi?.victor_esi ?? "—";
  const reason = esi?.adjustment_reason;
  const hasNurseOverride = nurseEsi != null && nurseEsi !== adj;

  return (
    <div className="panel">
      <div className="panel-header">ESI score</div>
      <div className="p-4">
        <div className={`grid gap-3 ${hasNurseOverride ? "grid-cols-3" : "grid-cols-2"}`}>
          <div>
            <div className="label-mono mb-1">standard</div>
            <div className="font-mono text-3xl text-bone-200">{std}</div>
          </div>
          <div>
            <div className="label-mono mb-1">V.I.C.T.O.R.</div>
            <div className="font-mono text-3xl text-signal">{adj}</div>
          </div>
          {hasNurseOverride && (
            <div>
              <div className="label-mono mb-1">RN Assessment</div>
              <div className="font-mono text-3xl text-bone-100">{nurseEsi}</div>
            </div>
          )}
        </div>
        {hasNurseOverride && (
          <div className="text-xs text-bone-300 mt-2 leading-snug font-mono" style={{
            padding: "6px 10px", borderRadius: 6,
            background: "rgba(255, 185, 95, 0.08)",
            border: "1px solid rgba(255, 185, 95, 0.2)",
          }}>
            Nurse manually set ESI {nurseEsi} — V.I.C.T.O.R. recommends ESI {adj}. Neither overrides the other.
          </div>
        )}
        <div className="text-xs text-bone-400 mt-3 leading-snug">
          {reason || "Awaiting evidence — score updates as concordance signals arrive."}
        </div>
      </div>
    </div>
  );
}
