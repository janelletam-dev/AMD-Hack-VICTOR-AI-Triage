export default function VoiceSelector({ onSelect }) {
  const labelStyle = {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
    textTransform: "uppercase", letterSpacing: "0.2em",
    color: "rgba(47, 217, 244, 0.7)",
  };

  return (
    <div style={{ maxWidth: 720, width: "100%", textAlign: "center" }}>
      <div style={{ ...labelStyle, marginBottom: 16 }}>
        who would you like to speak with?
      </div>
      <h2 style={{
        fontFamily: "'Space Grotesk', 'Inter', sans-serif",
        fontSize: 40, fontWeight: 700, letterSpacing: "-0.02em",
        color: "var(--vic-on-surface)", marginBottom: 16,
      }}>
        Pick a friendly voice.
      </h2>
      <p style={{
        color: "var(--vic-on-surface-variant)", fontSize: 16, lineHeight: 1.55,
        marginBottom: 40, fontWeight: 300,
      }}>
        Both will listen with care. You can change your mind anytime.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {[
          { id: "victor", name: "Victor", desc: "Calm, deliberate, lower register." },
          { id: "jackie", name: "Jackie", desc: "Warm, attentive, higher register." },
        ].map((v) => (
          <button
            key={v.id}
            onClick={() => onSelect(v.id)}
            className="vic-glass"
            style={{
              border: "1px solid rgba(69, 70, 77, 0.4)", borderRadius: 24,
              padding: 32, textAlign: "left", color: "var(--vic-on-surface)",
              cursor: "pointer", transition: "all 0.2s",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = "var(--vic-primary)";
              e.currentTarget.style.boxShadow = "0 8px 30px rgba(47, 217, 244, 0.2)";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = "rgba(69, 70, 77, 0.4)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <div style={{ ...labelStyle, marginBottom: 12 }}>voice</div>
            <div style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 28, fontWeight: 700, marginBottom: 6,
              color: "var(--vic-on-surface)",
            }}>{v.name}</div>
            <div style={{ color: "var(--vic-on-surface-variant)", fontSize: 14 }}>{v.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
