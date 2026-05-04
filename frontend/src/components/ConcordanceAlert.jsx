export default function ConcordanceAlert({ flag }) {
  if (!flag) return null;
  const tierColor =
    flag.tier === 1 ? "border-flag bg-flag/10" :
    flag.tier === 2 ? "border-signal bg-signal/10" :
    "border-ink-500 bg-ink-700";

  return (
    <div className={`m-4 border rounded-lg p-4 ${tierColor}`}>
      <div className="flex items-baseline justify-between mb-2">
        <div className="label-mono">concordance flag · tier {flag.tier}</div>
        <div className="label-mono">{flag.agent || "M.E.R.C.E.D."}</div>
      </div>
      <div className="text-bone-50 leading-relaxed mb-2 text-balance">
        {flag.gloss}
      </div>
      <div className="font-mono text-xs text-bone-400">
        trigger: "{flag.trigger_phrase}" · {flag.biomarker_signal}
      </div>
    </div>
  );
}
