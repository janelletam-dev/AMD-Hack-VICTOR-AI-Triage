export default function MicButton({ recording, onStart, onStop }) {
  const labelStyle = {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
    textTransform: "uppercase", letterSpacing: "0.18em", color: "#7a8696",
  };

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={recording ? onStop : onStart}
        aria-label={recording ? "Stop recording" : "Start recording"}
        style={{
          position: "relative", width: 112, height: 112, borderRadius: "50%",
          border: recording ? "1px solid #0e7c86" : "1px solid #c4ccd6",
          background: recording ? "#e3f2f3" : "#ffffff",
          color: recording ? "#0e7c86" : "#465364",
          cursor: "pointer", transition: "all .2s",
        }}
      >
        {recording && (
          <span style={{
            position: "absolute", inset: 0, borderRadius: "50%",
            border: "1px solid #0e7c86",
            animation: "ping 1.6s cubic-bezier(0,0,0.2,1) infinite",
          }} />
        )}
        <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor" style={{ display: "block", margin: "0 auto" }}>
          <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z" />
          <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.08A7 7 0 0 0 19 11z" />
        </svg>
      </button>
      <div style={{ ...labelStyle, position: "absolute", bottom: -28, left: 0, right: 0, textAlign: "center" }}>
        {recording ? "listening" : "tap to speak"}
      </div>
    </div>
  );
}
