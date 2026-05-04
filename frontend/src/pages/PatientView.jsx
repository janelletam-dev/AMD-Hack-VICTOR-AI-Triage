import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import VoiceSelector from "../components/VoiceSelector.jsx";
import { useWebSocket } from "../hooks/useWebSocket.js";
import { useAudioCapture } from "../hooks/useAudioCapture.js";
import { setIdentity as setStoreIdentity, clearIdentity } from "../state/identityStore.js";

const WS_BASE = import.meta.env.VITE_BACKEND_WS_URL || "ws://localhost:8000";
const HTTP_BASE = import.meta.env.VITE_BACKEND_HTTP_URL || "http://localhost:8000";

const PHASES = ["name", "dob", "complaint"];

// Show the bottom dev strip only when ?debug=1 is on the URL — keeps the
// kiosk UI clean and prevents overlap with the floating route toggle.
function showDebug() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("debug") === "1";
}

function phaseTTS(voice, phase) {
  const name = voice === "jackie" ? "Jackie" : "Victor";
  switch (phase) {
    case "name":
      return (
        `Hi, I'm ${name}, and I'm here to help you get checked in. ` +
        `Take your time — there's no rush. ` +
        `Whenever you're ready, could you tell me your full name?`
      );
    case "dob":
      return (
        `Thank you for that. ` +
        `And could you share your date of birth with me?`
      );
    case "complaint":
      return (
        `Thank you, that's everything I needed for check-in. ` +
        `Now, whenever you're ready, could you tell me more about ` +
        `what's been going on — what's bringing you in today, ` +
        `and any concerns on your mind? I'm here to listen.`
      );
    default:
      return "";
  }
}

function phasePrompt(phase) {
  switch (phase) {
    case "name":
      return { label: "Step 1 of 3", title: "Please share your full name." };
    case "dob":
      return { label: "Step 2 of 3", title: "And your date of birth?" };
    case "complaint":
      return {
        label: "Step 3 of 3",
        title: "Tell me more about your concerns.",
      };
    default:
      return { label: "", title: "" };
  }
}

function confirmTTS(voice, phase, value) {
  if (phase === "name") return `I have you down as ${value} — did I get that right?`;
  if (phase === "dob") return `Thank you. I have your date of birth as ${value} — is that correct?`;
  return "";
}

// Short retry prompts — used when the patient is being asked the same question
// again (parse failed, or they tapped "No, try again" on the confirm card).
// We don't repeat the full intro — they've already heard it.
function phaseRetryTTS(voice, phase) {
  switch (phase) {
    case "name":
      return "Could you tell me your full name?";
    case "dob":
      return "Could you share your date of birth?";
    case "complaint":
      return "Could you tell me a bit more about what's going on?";
    default:
      return "";
  }
}

// --- Validation helpers --------------------------------------------------

// Patterns peeled off the start of a spoken name.
// FILLER: greetings + acks ("hi", "hello there", "yes", "good morning", …).
// ANNOUNCE: name-introduction phrases ("my name is", "i'm", "this is", …).
// STOP_WORDS: end-of-name signals — once we hit one we stop collecting tokens
// (handles "Janelle Tamayo and I have chest pain" → "Janelle Tamayo").
const NAME_FILLER = /^(hi|hello|hey|yes|yeah|yep|nope|ok|okay|sure|well|uh|um|so|hi there|hello there|good morning|good afternoon|good evening)\b[\s,]*/i;
const NAME_ANNOUNCE = /^(my full name is|my name is|my name's|i'?m|i am|this is|it'?s|name is|name's|they call me|the name'?s|call me)\b[\s,]*/i;
const NAME_STOP_WORDS = new Set([
  "and", "but", "for", "with", "i", "im", "ill", "ive",
  "have", "got", "feeling", "feel", "experiencing", "here",
  "from", "to", "of", "the", "a",
]);

function parseName(raw) {
  if (!raw) return { ok: false, message: "I didn't catch a name." };

  // Normalize: punctuation → space, collapse whitespace.
  let cleaned = raw
    .replace(/[.,!?;:"`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Peel off any number of leading filler/announce phrases. Loop because
  // patients often combine them: "Hi, my name is Janelle Tamayo".
  let prev;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(NAME_FILLER, "").replace(NAME_ANNOUNCE, "").trim();
  } while (cleaned !== prev);

  // Walk tokens left-to-right. Keep name-shaped ones, stop at a stop word
  // or anything that doesn't look like part of a name.
  const isNameWord = (t) => /^[A-Za-zÀ-ÿ'’\-]{2,}$/.test(t);
  const nameTokens = [];
  for (const tok of cleaned.split(" ")) {
    const lower = tok.toLowerCase().replace(/'/g, "");
    if (NAME_STOP_WORDS.has(lower)) break;
    if (!isNameWord(tok)) continue;
    nameTokens.push(tok);
    if (nameTokens.length >= 4) break;
  }

  // Dedupe BEFORE the count check, so "Janelle Janelle" still fails the
  // first+last requirement, and "Janelle Tamayo Janelle Tamayo" passes as
  // "Janelle Tamayo".
  const deduped = dedupeRepeatedSequence(nameTokens);
  if (deduped.length < 2) {
    return { ok: false, message: "I need both your first and last name." };
  }
  const titled = deduped.map(
    (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
  );
  return { ok: true, value: titled.join(" ") };
}

// If the token list is two identical halves ([A,B,A,B] or [A,A]), return the
// unique half. Otherwise return the tokens unchanged.
function dedupeRepeatedSequence(tokens) {
  const lower = tokens.map((t) => t.toLowerCase());
  const n = lower.length;
  for (let half = 1; half <= Math.floor(n / 2); half++) {
    if (n % half !== 0) continue;
    let allMatch = true;
    for (let i = half; i < n; i++) {
      if (lower[i] !== lower[i % half]) { allMatch = false; break; }
    }
    if (allMatch) return tokens.slice(0, half);
  }
  return tokens;
}

const MONTH_WORDS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

// Spoken-number → digit conversion. Handles patterns patients actually use:
//   "one nine nine zero"          → "1990"
//   "nineteen ninety"             → "1990"
//   "nineteen ninety two"         → "1992"
//   "twenty twenty three"         → "2023"
//   "two thousand three"          → "2003"
//   "January fifteenth nineteen ninety" → "January 15 1990"
const SPOKEN_NUM = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SPOKEN_ORDINAL = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};

function wordsToNumbers(input) {
  if (!input) return input;
  // Hyphens like "twenty-five" → "twenty five" so each word can match.
  let s = " " + input.toLowerCase().replace(/-/g, " ") + " ";

  // Substitute ordinals + cardinals with their digit equivalents.
  for (const [w, n] of Object.entries(SPOKEN_ORDINAL)) {
    s = s.replace(new RegExp(`\\b${w}\\b`, "g"), String(n));
  }
  for (const [w, n] of Object.entries(SPOKEN_NUM)) {
    s = s.replace(new RegExp(`\\b${w}\\b`, "g"), String(n));
  }
  // Multiplier words become numeric placeholders so the compound passes below
  // can spot them. Order matters: "thousand" before "hundred" wouldn't actually
  // change anything since they're independent words.
  s = s.replace(/\bthousand\b/g, "1000");
  s = s.replace(/\bhundred\b/g, "100");

  // "X thousand [and] Y" — handle before plain hundred, since 1000 includes 100.
  s = s.replace(/\b(\d+)\s+1000(?:\s+and)?(?:\s+(\d+))?\b/g,
    (_, x, y) => String(parseInt(x, 10) * 1000 + (y ? parseInt(y, 10) : 0)));
  s = s.replace(/\b1000(?:\s+and)?\s+(\d+)\b/g, (_, y) => String(1000 + parseInt(y, 10)));

  // "X hundred [and] Y"
  s = s.replace(/\b(\d+)\s+100(?:\s+and)?(?:\s+(\d+))?\b/g,
    (_, x, y) => String(parseInt(x, 10) * 100 + (y ? parseInt(y, 10) : 0)));
  s = s.replace(/\b100(?:\s+and)?\s+(\d+)\b/g, (_, y) => String(100 + parseInt(y, 10)));

  // Tens + units: "20 5" → "25"
  s = s.replace(/\b([2-9]0)\s+([1-9])\b/g,
    (_, t, u) => String(parseInt(t, 10) + parseInt(u, 10)));

  // Year compound: only match centuries 19xx or 20xx as the prefix. Limiting
  // to (19|20) avoids the regex greedily eating "15 19" out of "15 19 90"
  // and starving "19 90" of its match.
  const thisYear = new Date().getFullYear();
  s = s.replace(/\b(19|20)\s+(\d{1,2})\b/g, (m, hi, lo) => {
    const c = parseInt(hi, 10) * 100 + parseInt(lo, 10);
    return c >= 1900 && c <= thisYear ? String(c) : m;
  });

  // Digit-by-digit year: "1 9 9 0" → "1990"
  s = s.replace(/\b(\d)\s+(\d)\s+(\d)\s+(\d)\b/g, (m, a, b, c, d) => {
    const v = a + b + c + d;
    const n = parseInt(v, 10);
    return n >= 1900 && n <= thisYear ? v : m;
  });

  return s.trim().replace(/\s+/g, " ");
}

function isValidYMD(y, m, d) {
  if (!y || !m || !d) return false;
  if (m < 1 || m > 12) return false;
  const dim = new Date(y, m, 0).getDate();
  if (d < 1 || d > dim) return false;
  const now = new Date();
  if (y < 1900 || y > now.getFullYear()) return false;
  return true;
}

function formatYMD(y, m, d) {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[m - 1]} ${d}, ${y}`;
}

function parseDOB(raw) {
  if (!raw) return { ok: false, message: "I didn't catch a date." };
  // First convert spoken digits ("nineteen ninety" → "1990") so the rest
  // of the parser only sees numbers.
  const normalized = wordsToNumbers(raw);
  const text = normalized.toLowerCase().replace(/(\d+)(st|nd|rd|th)/g, "$1");

  // 1) Numeric: M/D/Y, M-D-Y, M.D.Y, also space-separated "1 15 1990".
  const num = text.match(/\b(\d{1,4})[\/\-.\s]+(\d{1,2})[\/\-.\s]+(\d{1,4})\b/);
  if (num) {
    const a = parseInt(num[1], 10);
    const b = parseInt(num[2], 10);
    const c = parseInt(num[3], 10);
    const candidates = [];
    // YYYY-MM-DD
    if (a > 31) candidates.push([a, b, c]);
    // MM/DD/YYYY
    if (a <= 12) candidates.push([c < 100 ? 1900 + c : c, a, b]);
    // DD/MM/YYYY
    if (b <= 12 && a <= 31 && a > 12) candidates.push([c < 100 ? 1900 + c : c, b, a]);
    // ambiguous a≤12 b≤12: prefer MM/DD/YYYY (US default)
    if (a <= 12 && b <= 12 && c >= 1900) candidates.push([c, a, b]);
    for (const [y, m, d] of candidates) {
      if (isValidYMD(y, m, d)) return { ok: true, value: formatYMD(y, m, d) };
    }
    return { ok: false, message: "That date doesn't look right. Please try again." };
  }

  // 2) Word month: "January 15 1980", "15 January 1980", "Jan 15th, 1980"
  const monthRe = new RegExp(
    `\\b(${Object.keys(MONTH_WORDS).join("|")})\\b`,
    "i"
  );
  const mw = text.match(monthRe);
  const yearMatch = text.match(/\b(19\d{2}|20\d{2})\b/);
  const dayMatch = text.match(/\b([1-9]|[12]\d|3[01])\b/);
  if (mw && yearMatch && dayMatch) {
    const m = MONTH_WORDS[mw[1].toLowerCase()];
    const y = parseInt(yearMatch[1], 10);
    const d = parseInt(dayMatch[1], 10);
    if (isValidYMD(y, m, d)) return { ok: true, value: formatYMD(y, m, d) };
  }

  return { ok: false, message: "I didn't get a valid date — please say it like January 15, 1980." };
}

export default function PatientView() {
  const [step, setStep] = useState("welcome");
  const [voice, setVoice] = useState(null);
  const [room] = useState(() => {
    const url = new URL(window.location.href);
    return url.searchParams.get("room") || "demo";
  });
  const [framesSent, setFramesSent] = useState(0);
  const [interimText, setInterimText] = useState("");
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [answers, setAnswers] = useState({ name: "", dob: "", complaint: "" });
  // confirm sub-step: when set, we've parsed the answer and are asking the
  // patient to confirm before advancing.
  const [confirm, setConfirm] = useState(null); // { phase, value } | null
  const [parseError, setParseError] = useState("");
  const phase = PHASES[phaseIdx];

  const wsUrl = useMemo(
    () => (step === "interview" ? `${WS_BASE}/ws/audio?room=${room}&voice=${voice}` : null),
    [step, room, voice]
  );

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // phaseTextRef holds the accumulated *final* transcript text for the current
  // phase. lastFinalRef holds the most recent final segment so we can dedupe
  // when Deepgram re-emits the same segment.
  const phaseTextRef = useRef("");
  const lastFinalRef = useRef("");

  const onEvent = useCallback((evt) => {
    if (evt.type !== "transcript" || !evt.data?.text) return;
    const text = evt.data.text.trim();
    if (!text) return;
    setInterimText(text);
    if (!evt.data.is_final) return;

    const p = phaseRef.current;
    // Skip if Deepgram re-emits the same final segment (or a prefix of one
    // we already have). This is the source of "Janelle Tamayo Janelle Tamayo".
    if (text === lastFinalRef.current) return;
    if (phaseTextRef.current && phaseTextRef.current.endsWith(text)) return;

    // Unified accumulation rule for all phases:
    //   - empty so far → take it
    //   - new text already contained in what we have → skip (duplicate)
    //   - new text is a superset of what we have → replace (Deepgram refined)
    //   - otherwise → it's a different segment of the same answer; append.
    // Handles "January 15th" + "1990" (DOB) and dedupes "Janelle Tamayo" echoes.
    const prevLower = phaseTextRef.current.toLowerCase();
    const newLower = text.toLowerCase();
    if (!phaseTextRef.current) {
      phaseTextRef.current = text;
    } else if (prevLower.includes(newLower)) {
      // duplicate / subset — keep prev
    } else if (newLower.includes(prevLower)) {
      phaseTextRef.current = text;
    } else {
      phaseTextRef.current = (phaseTextRef.current + " " + text).trim();
    }
    lastFinalRef.current = text;
    setAnswers((a) => ({ ...a, [p]: phaseTextRef.current }));
  }, []);

  const { status, sendBinary, send } = useWebSocket(wsUrl, { onEvent });

  const onFrame = useCallback(
    (buf) => {
      if (sendBinary(buf)) setFramesSent((n) => n + 1);
    },
    [sendBinary]
  );

  const { state: micState, start, stop } = useAudioCapture({ onFrame });

  const audioRef = useRef(null);
  const [ttsState, setTtsState] = useState("idle");

  const playTTS = useCallback((text) => {
    if (!text || !voice) return;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const url = `${HTTP_BASE}/api/tts?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}`;
    const audio = new Audio(url);
    audioRef.current = audio;
    setTtsState("speaking");
    audio.addEventListener("ended", () => setTtsState("done"));
    audio.addEventListener("error", () => setTtsState("error"));
    audio.play().catch(() => setTtsState("error"));
  }, [voice]);

  // Play the question prompt whenever the active phase changes.
  useEffect(() => {
    if (step !== "interview" || !voice) return;
    if (confirm) return; // don't replay the question while we're confirming
    playTTS(phaseTTS(voice, phase));
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, voice, phase]);

  // Tell the backend (and clinician dashboard) when the phase advances.
  useEffect(() => {
    if (step !== "interview") return;
    send && send({ type: "phase", data: { phase, index: phaseIdx } });
  }, [step, phase, phaseIdx, send]);

  const beginInterview = (selected) => {
    setVoice(selected);
    setStep("interview");
    setPhaseIdx(0);
    setAnswers({ name: "", dob: "", complaint: "" });
    phaseTextRef.current = "";
    lastFinalRef.current = "";
    setInterimText("");
    setConfirm(null);
    setParseError("");
    // Reset the cross-view store at the start of a new interview.
    clearIdentity();
  };

  // User taps mic to stop. For name/DOB, parse + confirm; for complaint, save.
  const handleStopMic = useCallback(() => {
    stop();
    const captured = (phaseTextRef.current || interimText || "").trim();
    if (!captured) return;
    if (phase === "name") {
      const r = parseName(captured);
      if (!r.ok) {
        setParseError(r.message);
        playTTS(phaseRetryTTS(voice, phase));
        phaseTextRef.current = "";
        lastFinalRef.current = "";
        setInterimText("");
        return;
      }
      setParseError("");
      setConfirm({ phase: "name", value: r.value });
      playTTS(confirmTTS(voice, "name", r.value));
    } else if (phase === "dob") {
      const r = parseDOB(captured);
      if (!r.ok) {
        setParseError(r.message);
        playTTS(phaseRetryTTS(voice, phase));
        phaseTextRef.current = "";
        lastFinalRef.current = "";
        setInterimText("");
        return;
      }
      setParseError("");
      setConfirm({ phase: "dob", value: r.value });
      playTTS(confirmTTS(voice, "dob", r.value));
    } else {
      // complaint — keep the text as-is, no confirmation required
      setAnswers((a) => ({ ...a, complaint: captured }));
    }
  }, [phase, voice, stop, interimText, playTTS]);

  const onConfirmYes = useCallback(() => {
    if (!confirm) return;
    setAnswers((a) => ({ ...a, [confirm.phase]: confirm.value }));
    setStoreIdentity({ [confirm.phase]: confirm.value });
    send && send({
      type: "identity_update",
      data: { [confirm.phase]: confirm.value },
    });
    setConfirm(null);
    setParseError("");
    setInterimText("");
    phaseTextRef.current = "";
    lastFinalRef.current = "";
    if (phaseIdx < PHASES.length - 1) setPhaseIdx((i) => i + 1);
    else setStep("done");
  }, [confirm, phaseIdx, send]);

  const onConfirmRetry = useCallback(() => {
    setConfirm(null);
    setParseError("");
    setInterimText("");
    phaseTextRef.current = "";
    lastFinalRef.current = "";
    setAnswers((a) => ({ ...a, [phase]: "" }));
    playTTS(phaseRetryTTS(voice, phase));
  }, [phase, voice, playTTS]);

  const advancePhase = useCallback(() => {
    stop();
    const captured = (phaseTextRef.current || interimText || "").trim();
    if (phase === "complaint" && captured) {
      setAnswers((a) => ({ ...a, complaint: captured }));
      setStoreIdentity({ complaint: captured });
      send && send({ type: "identity_update", data: { complaint: captured } });
    }
    setInterimText("");
    phaseTextRef.current = "";
    if (phaseIdx < PHASES.length - 1) setPhaseIdx((i) => i + 1);
    else setStep("done");
  }, [phase, phaseIdx, stop, interimText, send]);

  return (
    <div style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      background: "var(--vic-bg)", color: "var(--vic-on-surface)",
      fontFamily: "'Inter', system-ui, sans-serif",
      position: "relative", overflow: "hidden",
    }}>
      <AmbientGlow />
      <KioskHeader />

      <main style={{
        flex: 1, display: "flex", flexDirection: "column",
        alignItems: "center",
        // Welcome / VoiceSelector / Done are short — center them.
        // Interview is tall — top-align so it doesn't squash into the header.
        justifyContent: step === "interview" ? "flex-start" : "center",
        // Top padding clears the kiosk header (80px); bottom padding clears
        // the kiosk footer (64px). Route toggle now lives top-left so we
        // don't need extra clearance there.
        padding: step === "interview" ? "112px 24px 96px" : "96px 24px 96px",
        position: "relative", zIndex: 10,
      }}>
        {step === "welcome" && <Welcome onBegin={() => setStep("select")} />}
        {step === "select" && <VoiceSelector onSelect={beginInterview} />}
        {step === "interview" && (
          <Interview
            voice={voice}
            wsStatus={status}
            ttsState={ttsState}
            micState={micState}
            phase={phase}
            phaseIdx={phaseIdx}
            answers={answers}
            interimText={interimText}
            confirm={confirm}
            parseError={parseError}
            framesSent={framesSent}
            onStart={start}
            onStopMic={handleStopMic}
            onAdvance={advancePhase}
            onConfirmYes={onConfirmYes}
            onConfirmRetry={onConfirmRetry}
          />
        )}
        {step === "done" && <Done room={room} answers={answers} />}
      </main>

      <KioskFooter />
    </div>
  );
}

function AmbientGlow() {
  return (
    <>
      <div style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        width: 600, height: 600, borderRadius: "50%",
        background: "rgba(47, 217, 244, 0.05)", filter: "blur(120px)",
        pointerEvents: "none", zIndex: 0,
      }} />
      <div style={{
        position: "absolute", bottom: 0, right: 0,
        width: 400, height: 400, borderRadius: "50%",
        background: "rgba(255, 185, 95, 0.05)", filter: "blur(100px)",
        pointerEvents: "none", zIndex: 0,
      }} />
      <div style={{
        position: "absolute", top: -128, left: -128,
        width: 256, height: 256, borderRadius: "50%",
        border: "1px solid rgba(47, 217, 244, 0.2)",
        pointerEvents: "none", zIndex: 0,
      }} />
      <div style={{
        position: "absolute", top: -96, left: -96,
        width: 256, height: 256, borderRadius: "50%",
        border: "1px solid rgba(47, 217, 244, 0.08)",
        pointerEvents: "none", zIndex: 0,
      }} />
    </>
  );
}

function KioskHeader() {
  return (
    <header style={{
      position: "fixed", top: 0, left: 0, right: 0, height: 80,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "0 32px", zIndex: 50,
      background: "rgba(12, 19, 36, 0.6)",
      backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
      boxShadow: "0 20px 50px rgba(47, 217, 244, 0.08)",
    }}>
      <span style={{
        fontFamily: "'Space Grotesk', 'Inter', sans-serif",
        fontSize: 24, fontWeight: 700, letterSpacing: "-0.04em",
        color: "var(--vic-primary)",
      }}>
        V.I.C.T.O.R. ER Triage
      </span>
    </header>
  );
}

function KioskFooter() {
  return (
    <footer style={{
      position: "fixed", bottom: 0, left: 0, right: 0, height: 64,
      padding: "0 32px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      background: "rgba(21, 27, 45, 0.4)",
      backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
      borderTop: "1px solid rgba(69, 70, 77, 0.15)",
      zIndex: 20,
    }}>
      <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
        <Stat dot="var(--vic-secondary)" label="System Status: Optimal" />
        <Stat label="End-to-End HIPAA Encrypted" />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ color: "var(--vic-on-surface-variant)", fontSize: 11 }}>
          V.I.C.T.O.R. Core v4.2.0
        </span>
        <span style={{
          color: "var(--vic-primary)", fontSize: 11, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: "0.18em",
        }}>
          Support
        </span>
      </div>
    </footer>
  );
}

function Stat({ dot, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {dot && (
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot }} />
      )}
      <span style={{
        color: "var(--vic-on-surface-variant)", fontSize: 11, fontWeight: 500,
        textTransform: "uppercase", letterSpacing: "0.06em",
      }}>{label}</span>
    </div>
  );
}

function Welcome({ onBegin }) {
  return (
    <div style={{ maxWidth: 560, width: "100%", textAlign: "center" }}>
      <h1 style={{
        fontFamily: "'Space Grotesk', 'Inter', sans-serif",
        fontSize: 48, fontWeight: 700, letterSpacing: "-0.02em",
        color: "var(--vic-on-surface)", marginBottom: 16,
      }}>
        We're here to help.
      </h1>
      <p style={{
        color: "var(--vic-on-surface-variant)", fontSize: 18, lineHeight: 1.6,
        marginBottom: 24, fontWeight: 300,
      }}>
        In a moment, you'll have a short conversation with one of our care assistants.
        Just a few questions out loud — it helps the right clinician get to you sooner.
      </p>
      <PrivacyNote style={{ marginBottom: 32 }} />
      <button
        onClick={onBegin}
        style={{
          padding: "16px 40px", borderRadius: 999,
          background: "linear-gradient(to right, var(--vic-primary), #008ea1)",
          color: "var(--vic-on-primary)", fontWeight: 700, fontSize: 16,
          border: "none", cursor: "pointer", letterSpacing: "0.02em",
          boxShadow: "0 8px 30px rgba(47, 217, 244, 0.3)",
        }}
      >
        Begin
      </button>
    </div>
  );
}

function PrivacyNote({ style }) {
  return (
    <div style={{
      ...style,
      display: "inline-flex", gap: 10, alignItems: "flex-start",
      padding: "10px 16px", borderRadius: 12,
      background: "rgba(47, 217, 244, 0.06)",
      border: "1px solid rgba(47, 217, 244, 0.18)",
      color: "var(--vic-on-surface-variant)",
      fontSize: 12, lineHeight: 1.5, textAlign: "left",
      maxWidth: 520,
    }}>
      <span style={{ color: "var(--vic-primary)", flexShrink: 0, marginTop: 1 }}>🔒</span>
      <span>
        <strong style={{ color: "var(--vic-on-surface)", fontWeight: 600 }}>Your audio stays private.</strong>{" "}
        It's processed in real time and not recorded or stored. Only the clinical
        summary is shared with your care team.
      </span>
    </div>
  );
}

function Interview({
  voice, wsStatus, ttsState, micState,
  phase, phaseIdx, answers, interimText, confirm, parseError,
  framesSent, onStart, onStopMic, onAdvance, onConfirmYes, onConfirmRetry,
}) {
  const recording = micState === "recording";
  const error = micState === "error";
  const speaking = ttsState === "speaking";
  const { label, title } = phasePrompt(phase);
  const captured = answers[phase] || "";
  const liveText = interimText || captured;
  const isLast = phaseIdx === PHASES.length - 1;
  const isConfirming = !!confirm;

  let subline;
  if (isConfirming) subline = "Just want to make sure I got this right.";
  else if (speaking) subline = "Take your time — I'll be ready to listen when you are.";
  else if (recording) subline = "I'm listening — share whatever feels right.";
  else if (parseError) subline = parseError;
  else if (captured && phase === "complaint") subline = "Thank you for sharing that. Tap continue when you're ready, or the mic if there's more.";
  else if (phase === "complaint") subline = "Whenever you're ready, tap the microphone — I'm here to listen.";
  else subline = "Whenever you're ready, tap the microphone and share with me.";

  const advanceLabel = isLast ? "Send to my care team →" : "Continue →";
  const canAdvance = !!captured.trim() && !isConfirming;

  return (
    <div style={{
      width: "100%", maxWidth: 960,
      display: "flex", flexDirection: "column", alignItems: "center", gap: 24,
    }}>
      <PhaseStepper phaseIdx={phaseIdx} answers={answers} />

      <div style={{ textAlign: "center", maxWidth: 640 }}>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700,
          color: "var(--vic-primary)", textTransform: "uppercase",
          letterSpacing: "0.2em", marginBottom: 10,
        }}>
          {label}
        </div>
        <h1 style={{
          fontFamily: "'Space Grotesk', 'Inter', sans-serif",
          fontSize: 40, fontWeight: 700, letterSpacing: "-0.02em",
          color: "var(--vic-on-surface)", marginBottom: 12,
        }}>
          {title}
        </h1>
        <p style={{
          color: "var(--vic-on-surface-variant)", fontSize: 17, fontWeight: 300,
          lineHeight: 1.55, margin: 0,
        }}>
          {subline}
        </p>
      </div>

      {!isConfirming && (
        <MicCircle recording={recording} error={error} onClick={recording ? onStopMic : onStart} />
      )}

      <StatusPill recording={recording} error={error} ttsState={ttsState} wsStatus={wsStatus} />

      {error && <MicErrorHelp onRetry={onStart} />}

      {isConfirming ? (
        <ConfirmCard confirm={confirm} onYes={onConfirmYes} onRetry={onConfirmRetry} />
      ) : (
        <TranscriptCard transcript={liveText} active={recording || speaking} phase={phase} />
      )}

      {!isConfirming && phase === "complaint" && (
        <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
          <button
            onClick={onAdvance}
            disabled={!canAdvance}
            style={{
              padding: "14px 36px", borderRadius: 999,
              background: canAdvance
                ? "linear-gradient(to right, var(--vic-primary), #008ea1)"
                : "var(--vic-bg-highest)",
              color: canAdvance ? "var(--vic-on-primary)" : "var(--vic-on-surface-variant)",
              fontWeight: 700, fontSize: 16,
              border: "none", cursor: canAdvance ? "pointer" : "not-allowed",
              boxShadow: canAdvance ? "0 8px 30px rgba(47, 217, 244, 0.3)" : "none",
              display: "flex", alignItems: "center", gap: 12,
            }}
          >
            {advanceLabel}
          </button>
        </div>
      )}

      <PrivacyNote />

      {showDebug() && (
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
          color: "var(--vic-on-surface-variant)", opacity: 0.6,
          textTransform: "uppercase", letterSpacing: "0.18em",
        }}>
          voice: {voice} · phase: {phase} · ws: {wsStatus} · tts: {ttsState} · frames: {framesSent}
        </div>
      )}
    </div>
  );
}

function PhaseStepper({ phaseIdx, answers }) {
  const items = [
    { key: "name", label: "Name" },
    { key: "dob", label: "Date of birth" },
    { key: "complaint", label: "Reason for visit" },
  ];
  return (
    <div style={{
      display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
      justifyContent: "center", marginBottom: 4,
    }}>
      {items.map((it, i) => {
        const done = !!(answers[it.key] || "").trim() && i < phaseIdx;
        const active = i === phaseIdx;
        const color = done
          ? "var(--vic-primary)"
          : active
          ? "var(--vic-on-surface)"
          : "var(--vic-on-surface-variant)";
        return (
          <div key={it.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              width: 22, height: 22, borderRadius: "50%",
              border: `1px solid ${color}`,
              display: "grid", placeItems: "center",
              fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
              color, fontWeight: 700,
              background: active ? "rgba(47, 217, 244, 0.08)" : "transparent",
            }}>
              {done ? "✓" : i + 1}
            </span>
            <span style={{
              fontSize: 11, color, fontWeight: active ? 700 : 500,
              textTransform: "uppercase", letterSpacing: "0.12em",
            }}>{it.label}</span>
            {i < items.length - 1 && (
              <span style={{
                width: 24, height: 1, background: "var(--vic-on-surface-variant)",
                opacity: 0.4, marginLeft: 4,
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function MicCircle({ recording, error, onClick }) {
  return (
    <div style={{ position: "relative", display: "flex", justifyContent: "center" }}>
      <button
        onClick={onClick}
        aria-label={recording ? "Stop recording" : "Start recording"}
        className={recording ? "vic-mic-pulse" : ""}
        style={{
          position: "relative", width: 240, height: 240, borderRadius: "50%",
          background: error
            ? "linear-gradient(to top right, var(--vic-error-bg), var(--vic-error))"
            : "linear-gradient(to top right, var(--vic-primary), #67e8f9)",
          border: "none", cursor: "pointer", transition: "transform .2s",
          display: "grid", placeItems: "center",
          boxShadow: error
            ? "0 0 60px rgba(255, 180, 171, 0.4)"
            : "0 0 60px rgba(47, 217, 244, 0.4)",
        }}
      >
        <svg viewBox="0 0 24 24" width="96" height="96" fill="var(--vic-on-primary)">
          <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z"/>
          <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.08A7 7 0 0 0 19 11z"/>
        </svg>
      </button>
    </div>
  );
}

function MicErrorHelp({ onRetry }) {
  return (
    <div style={{
      maxWidth: 520, padding: "16px 20px", borderRadius: 12,
      background: "rgba(255, 180, 171, 0.08)",
      border: "1px solid rgba(255, 180, 171, 0.25)",
      color: "var(--vic-on-error-bg)", textAlign: "left",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        We couldn't access your microphone. Click the lock or camera icon
        in your browser's address bar and allow microphone access for this site,
        then try again.
      </div>
      <button
        onClick={onRetry}
        style={{
          padding: "8px 16px", borderRadius: 999,
          background: "var(--vic-error)", color: "var(--vic-error-bg)",
          border: "none", cursor: "pointer", alignSelf: "flex-start",
          fontWeight: 700, fontSize: 12,
          textTransform: "uppercase", letterSpacing: "0.1em",
        }}
      >
        Try again
      </button>
    </div>
  );
}

function StatusPill({ recording, error, ttsState, wsStatus }) {
  let label, color;
  if (error) { label = "Microphone permission denied"; color = "var(--vic-error)"; }
  else if (recording) { label = "Listening Now..."; color = "var(--vic-primary)"; }
  else if (ttsState === "speaking") { label = "Speaking..."; color = "var(--vic-primary)"; }
  else if (wsStatus === "open") { label = "Ready — tap to speak"; color = "var(--vic-primary)"; }
  else { label = `Connecting (${wsStatus})…`; color = "var(--vic-on-surface-variant)"; }

  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      padding: "8px 16px", borderRadius: 999,
      background: error ? "rgba(255, 180, 171, 0.1)" : "rgba(47, 217, 244, 0.1)",
      border: `1px solid ${error ? "rgba(255, 180, 171, 0.2)" : "rgba(47, 217, 244, 0.2)"}`,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%", background: color,
        animation: recording || ttsState === "speaking" ? "ping 1.5s infinite" : "none",
      }} />
      <span style={{
        color, fontSize: 12, fontWeight: 500,
        textTransform: "uppercase", letterSpacing: "0.08em",
      }}>{label}</span>
    </div>
  );
}

function TranscriptCard({ transcript, active, phase }) {
  const empty = !transcript;
  const heading = phase === "name"
    ? "Heard — Name"
    : phase === "dob"
    ? "Heard — Date of birth"
    : phase === "complaint"
    ? "Heard — Reason for visit"
    : "Live Transcription";
  const placeholder = phase === "name"
    ? "Awaiting your name…"
    : phase === "dob"
    ? "Awaiting your date of birth…"
    : phase === "complaint"
    ? "Awaiting your answer…"
    : "Awaiting your voice…";

  return (
    <div className="vic-glass" style={{
      width: "100%", padding: 32, borderRadius: 32,
      border: "1px solid rgba(69, 70, 77, 0.15)",
      boxShadow: "0 32px 64px -12px rgba(0, 0, 0, 0.5)",
      minHeight: 140,
    }}>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <span style={{ color: "var(--vic-primary)", fontSize: 22, marginTop: 4 }}>✦</span>
        <div style={{ flex: 1 }}>
          <div style={{
            fontSize: 11, fontWeight: 700, textTransform: "uppercase",
            letterSpacing: "0.2em", color: "rgba(47, 217, 244, 0.6)", marginBottom: 8,
          }}>
            {heading}
          </div>
          <p
            className={active && !empty ? "vic-typing-cursor" : ""}
            style={{
              fontSize: 24, lineHeight: 1.55, color: "var(--vic-on-surface)",
              fontWeight: 400, margin: 0,
              opacity: empty ? 0.4 : 1,
              fontStyle: empty ? "italic" : "normal",
            }}
          >
            {empty ? placeholder : transcript}
          </p>
        </div>
      </div>
    </div>
  );
}

function ConfirmCard({ confirm, onYes, onRetry }) {
  const heading = confirm.phase === "name"
    ? "Just want to make sure I have your name right."
    : "And your date of birth — did I get this right?";
  return (
    <div className="vic-glass" style={{
      width: "100%", padding: 32, borderRadius: 32,
      border: "1px solid rgba(47, 217, 244, 0.3)",
      boxShadow: "0 32px 64px -12px rgba(0, 0, 0, 0.5)",
      display: "flex", flexDirection: "column", gap: 20, alignItems: "center",
      textAlign: "center",
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, textTransform: "uppercase",
        letterSpacing: "0.2em", color: "var(--vic-primary)",
      }}>
        Please confirm
      </div>
      <div style={{ fontSize: 18, color: "var(--vic-on-surface-variant)" }}>
        {heading}
      </div>
      <div style={{
        fontFamily: "'Space Grotesk', 'Inter', sans-serif",
        fontSize: 38, fontWeight: 700, color: "var(--vic-on-surface)",
        letterSpacing: "-0.01em",
      }}>
        {confirm.value}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        <button
          onClick={onYes}
          style={{
            padding: "14px 32px", borderRadius: 999,
            background: "linear-gradient(to right, var(--vic-primary), #008ea1)",
            color: "var(--vic-on-primary)", fontWeight: 700, fontSize: 15,
            border: "none", cursor: "pointer",
            boxShadow: "0 8px 30px rgba(47, 217, 244, 0.3)",
          }}
        >
          ✓ Yes, that's correct
        </button>
        <button
          onClick={onRetry}
          style={{
            padding: "14px 32px", borderRadius: 999,
            background: "transparent",
            color: "var(--vic-on-surface)", fontWeight: 600, fontSize: 15,
            border: "1px solid rgba(255, 255, 255, 0.2)", cursor: "pointer",
          }}
        >
          ↺ No, let me try again
        </button>
      </div>
    </div>
  );
}

function Done({ room, answers = {} }) {
  return (
    <div style={{ maxWidth: 600, width: "100%", textAlign: "center" }}>
      <div style={{
        width: 96, height: 96, borderRadius: "50%", margin: "0 auto 24px",
        background: "rgba(47, 217, 244, 0.1)",
        border: "1px solid rgba(47, 217, 244, 0.2)",
        display: "grid", placeItems: "center", color: "var(--vic-primary)", fontSize: 36,
      }}>✓</div>
      <h1 style={{
        fontFamily: "'Space Grotesk', 'Inter', sans-serif",
        fontSize: 36, fontWeight: 700, marginBottom: 12,
        color: "var(--vic-on-surface)",
      }}>
        Thank you{answers.name ? `, ${answers.name.split(" ")[0]}` : ""}.
      </h1>
      <p style={{ color: "var(--vic-on-surface-variant)", fontSize: 16, marginBottom: 28 }}>
        A clinician will see you shortly. Your responses are being reviewed
        to make sure we don't miss anything.
      </p>

      {(answers.name || answers.dob || answers.complaint) && (
        <div className="vic-glass" style={{
          textAlign: "left", padding: 24, borderRadius: 24,
          border: "1px solid rgba(69, 70, 77, 0.15)",
          marginBottom: 24,
        }}>
          {answers.name && <SummaryRow label="Name" value={answers.name} />}
          {answers.dob && <SummaryRow label="Date of birth" value={answers.dob} />}
          {answers.complaint && <SummaryRow label="Reason for visit" value={answers.complaint} />}
        </div>
      )}

      <p style={{
        fontFamily: "'JetBrains Mono', monospace", color: "var(--vic-on-surface-variant)",
        fontSize: 11, textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 4,
      }}>
        Session ID
      </p>
      <p style={{
        fontFamily: "'JetBrains Mono', monospace", color: "var(--vic-primary)",
        fontSize: 14,
      }}>{room}</p>
    </div>
  );
}

function SummaryRow({ label, value }) {
  return (
    <div style={{
      padding: "12px 0", borderBottom: "1px solid rgba(69, 70, 77, 0.15)",
    }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700,
        color: "var(--vic-primary)", textTransform: "uppercase",
        letterSpacing: "0.18em", marginBottom: 4,
      }}>{label}</div>
      <div style={{
        fontSize: 16, color: "var(--vic-on-surface)", lineHeight: 1.5,
      }}>{value}</div>
    </div>
  );
}
