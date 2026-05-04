export default function ESIComparison({ esi }) {
  const std = esi?.standard_esi ?? "—";
  const adj = esi?.victor_esi ?? "—";
  const reason = esi?.adjustment_reason;

  return (
    <div className="panel">
      <div className="panel-header">ESI score</div>
      <div className="p-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="label-mono mb-1">standard</div>
            <div className="font-mono text-3xl text-bone-200">{std}</div>
          </div>
          <div>
            <div className="label-mono mb-1">V.I.C.T.O.R.</div>
            <div className="font-mono text-3xl text-signal">{adj}</div>
          </div>
        </div>
        <div className="text-xs text-bone-400 mt-3 leading-snug">
          {reason || "Awaiting evidence — score updates as concordance signals arrive."}
        </div>
      </div>
    </div>
  );
}
