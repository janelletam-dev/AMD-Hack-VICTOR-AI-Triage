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
  // Helios returns bucketed values {0, 0.33, 0.66, 1} per
  // docs.thymia.ai/helios/interpreting-results. Field names are
  // canonical — do not rename.
  const h = data?.helios || {};
  return (
    <div className="panel">
      <div className="panel-header">voice biomarkers · thymia helios</div>
      <div className="p-4 grid grid-cols-1 gap-3">
        <Gauge label="mental strain" value={h.mentalStrain} />
        <Gauge label="stress" value={h.stress} />
        <Gauge label="distress" value={h.distress} />
        <Gauge label="exhaustion" value={h.exhaustion} />
        <Gauge label="sleep propensity" value={h.sleepPropensity} />
        <Gauge label="low self-esteem" value={h.lowSelfEsteem} />
      </div>
    </div>
  );
}
