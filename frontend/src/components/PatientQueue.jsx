const QUEUE_STUB = [
  { id: "demo",   name: "Patient (demo)",  cc: "stomach pain",      status: "Escalated" },
  { id: "r-002",  name: "—",               cc: "chest pain",        status: "Urgent" },
  { id: "r-003",  name: "—",               cc: "fall",              status: "Standard" },
  { id: "r-004",  name: "—",               cc: "headache",          status: "Standard" },
  { id: "r-005",  name: "—",               cc: "ankle sprain",      status: "Observation" },
];

const STATUS_TONE = {
  Escalated:   "text-flag",
  Urgent:      "text-signal",
  Standard:    "text-bone-200",
  Observation: "text-bone-400",
  Discharged:  "text-bone-400",
};

export default function PatientQueue({ activeRoom, onSelect }) {
  return (
    <div className="panel flex flex-col min-h-0">
      <div className="panel-header">patient queue</div>
      <div className="overflow-auto">
        {QUEUE_STUB.map((p) => {
          const active = p.id === activeRoom;
          return (
            <button
              key={p.id}
              onClick={() => onSelect(p.id)}
              className={`w-full text-left px-4 py-3 border-b border-ink-700
                ${active ? "bg-ink-700" : "hover:bg-ink-700/50"}`}
            >
              <div className="flex items-center justify-between mb-0.5">
                <div className="text-bone-100 text-sm">{p.name}</div>
                <div className={`label-mono ${STATUS_TONE[p.status]}`}>
                  {p.status}
                </div>
              </div>
              <div className="text-xs text-bone-400">{p.cc}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
