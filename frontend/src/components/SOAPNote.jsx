export default function SOAPNote({ note }) {
  const sections = [
    ["S", "subjective", note?.subjective],
    ["O", "objective", note?.objective],
    ["A", "assessment", note?.assessment],
    ["P", "plan", note?.plan],
  ];
  return (
    <div className="panel">
      <div className="panel-header">soap note · S.C.R.I.B.E.</div>
      <div className="p-4 space-y-3 text-sm">
        {sections.map(([k, name, body]) => (
          <div key={k} className="grid grid-cols-[28px_1fr] gap-3">
            <div className="font-mono text-signal text-base leading-none">{k}</div>
            <div>
              <div className="label-mono mb-1">{name}</div>
              <div className="text-bone-100 leading-relaxed">
                {body || <span className="text-bone-400 italic">—</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
