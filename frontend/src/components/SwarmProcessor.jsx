const AGENTS = [
  { id: "V.I.C.T.O.R.", role: "triage leader" },
  { id: "M.E.R.C.E.D.", role: "concordance" },
  { id: "S.C.R.I.B.E.", role: "soap note" },
  { id: "J.A.C.K.I.E.", role: "patient voice" },
  { id: "E.L.M.E.R.", role: "evidence" },
];

export default function SwarmProcessor({ activity = {} }) {
  return (
    <div className="panel flex flex-col min-h-0">
      <div className="panel-header">swarm processor</div>
      <div className="p-4 space-y-2">
        {AGENTS.map((a) => {
          const act = activity[a.id];
          const live = act?.status === "active";
          return (
            <div
              key={a.id}
              className={`border rounded-md p-3 transition-colors ${
                live ? "border-signal bg-signal/5" : "border-ink-600 bg-ink-700"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="font-mono text-sm text-bone-50">{a.id}</div>
                <div
                  className={`w-2 h-2 rounded-full ${
                    live ? "bg-signal animate-pulse" : "bg-ink-500"
                  }`}
                />
              </div>
              <div className="label-mono mt-1">{a.role}</div>
              {act?.action && (
                <div className="text-xs text-bone-200 mt-1.5 leading-snug">
                  {act.action}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-auto border-t border-ink-600 p-4">
        <div className="label-mono mb-2">processing logs</div>
        <div className="font-mono text-xs text-bone-400 leading-relaxed">
          awaiting first event…
        </div>
      </div>
    </div>
  );
}
