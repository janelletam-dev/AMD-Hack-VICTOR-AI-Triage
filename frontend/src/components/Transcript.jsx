export default function Transcript({ lines = [] }) {
  return (
    <div className="panel">
      <div className="panel-header">live transcript</div>
      <div className="p-4 max-h-56 overflow-auto font-mono text-sm leading-relaxed text-bone-100">
        {lines.length === 0 ? (
          <div className="text-bone-400 italic">Awaiting audio…</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={l.is_final ? "text-bone-50" : "text-bone-400"}>
              <span className="label-mono mr-2">{l.language || "—"}</span>
              {l.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
