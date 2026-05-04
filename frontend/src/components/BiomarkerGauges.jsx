function Gauge({ label, value }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <div>
      <div className="flex justify-between mb-1">
        <span className="label-mono">{label}</span>
        <span className="font-mono text-xs text-bone-100">{pct}</span>
      </div>
      <div className="h-1.5 bg-ink-600 rounded-full overflow-hidden">
        <div
          className="h-full bg-signal transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function BiomarkerGauges({ data }) {
  const helios = data?.helios || {};
  const apollo = data?.apollo || {};
  return (
    <div className="panel">
      <div className="panel-header">voice biomarkers · thymia</div>
      <div className="p-4 grid grid-cols-1 gap-3">
        <div className="label-mono text-bone-200 mb-1">helios</div>
        <Gauge label="stress" value={helios.stress} />
        <Gauge label="distress" value={helios.distress} />
        <Gauge label="burnout" value={helios.burnout} />
        <Gauge label="tiredness" value={helios.tiredness} />
        <div className="label-mono text-bone-200 mb-1 mt-2">apollo</div>
        <Gauge label="anxiety" value={apollo.anxiety} />
        <Gauge label="depression" value={apollo.depression} />
      </div>
    </div>
  );
}
