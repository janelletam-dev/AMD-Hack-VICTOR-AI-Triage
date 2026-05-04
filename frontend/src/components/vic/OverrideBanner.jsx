export default function OverrideBanner({ flag }) {
  if (!flag) return null;
  return (
    <section style={{
      position: "relative", overflow: "hidden", borderRadius: 16,
      background: "rgba(147, 0, 10, 0.18)",
      border: "1px solid rgba(255, 180, 171, 0.3)",
      padding: 24, boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.4)",
    }}>
      <div className="vic-shimmer" style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 2,
      }} />
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        <div style={{
          width: 56, height: 56, borderRadius: 12,
          background: "var(--vic-error)", color: "var(--vic-error-bg)",
          display: "grid", placeItems: "center", flexShrink: 0,
          fontSize: 28, fontWeight: 700,
          boxShadow: "0 8px 24px rgba(255, 180, 171, 0.3)",
        }}>⚕</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h3 style={{
              margin: 0, fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 800, fontSize: 20, letterSpacing: "-0.02em",
              color: "var(--vic-error)",
            }}>
              {flag.agent || "J.A.C.K.I.E."} AI OVERRIDE
            </h3>
            <span style={{
              padding: "2px 8px", background: "var(--vic-error)",
              color: "var(--vic-error-bg)", borderRadius: 4,
              fontSize: 10, fontWeight: 900, textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}>
              Confidence: {flag.confidence ?? "94.2%"}
            </span>
          </div>
          <p style={{
            margin: 0, color: "var(--vic-on-error-bg)", fontWeight: 500,
            fontSize: 16, lineHeight: 1.6, maxWidth: 720,
          }}>
            {flag.message}
          </p>
        </div>
      </div>
    </section>
  );
}
