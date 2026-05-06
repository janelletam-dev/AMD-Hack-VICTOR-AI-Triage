import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { Clock, MessageCircle, Gauge, Flag } from "lucide-react";
import VoiceSelector from "../components/VoiceSelector.jsx";
import { useWebSocket } from "../hooks/useWebSocket.js";
import { useAudioCapture } from "../hooks/useAudioCapture.js";
import { setIdentity as setStoreIdentity, clearIdentity } from "../state/identityStore.js";

const WS_BASE = import.meta.env.VITE_BACKEND_WS_URL || "ws://localhost:8000";
const HTTP_BASE = import.meta.env.VITE_BACKEND_HTTP_URL || "http://localhost:8000";

// `conversation` is J.A.C.K.I.E.'s adaptive follow-up loop. It's not a
// fixed step like the prior three — the agent drives one question at a time
// from the backend via `jackie_turn` events until `triage_complete` fires.
// Name capture is split into first_name + last_name because STT accuracy
// on a single common word is ~95% vs ~60-70% on a full name (especially
// non-Anglo surnames). The two captured pieces are joined back into a
// single `name` field for downstream consumers (identityStore,
// sessionLog, EvidenceReport — those don't change shape).
const PHASES = ["first_name", "last_name", "dob", "complaint", "conversation"];

// Barge-in lets the patient interrupt TTS by speaking; we pause the audio.
// Risk: on a laptop without headphones, the mic can pick up TTS from the
// speakers, Deepgram transcribes it, and we false-trigger a barge-in (cuts
// off the assistant mid-sentence). Set to false for demo day if testing
// shows this happens. URL override: ?barge=0 disables, ?barge=1 forces on.
const BARGE_IN_ENABLED = (() => {
  if (typeof window === "undefined") return true;
  const v = new URLSearchParams(window.location.search).get("barge");
  if (v === "0") return false;
  if (v === "1") return true;
  return true;  // default on
})();

// Show the bottom dev strip only when ?debug=1 is on the URL — keeps the
// kiosk UI clean and prevents overlap with the floating route toggle.
function showDebug() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("debug") === "1";
}

// Triage-nurse register: brisk, competent, warm but never therapeutic.
// We convey calm with the voice + cadence, not by padding the prose with
// "take your time" / "no rush" — that reads as mismatched in an ER.
function phaseTTS(voice, phase) {
  const name = voice === "jackie" ? "Jackie" : "Victor";
  switch (phase) {
    case "first_name":
      // First impression: identify the assistant and ask the first
      // question. No "check in" / "intake" — that's hospitality framing.
      return `Hi, I'm ${name}. What's your first name?`;
    case "last_name":
      // No greeting — they've already met the assistant.
      return `And your last name?`;
    case "dob":
      return `Got it. And your date of birth?`;
    case "complaint":
      // Open-ended phrasing invites a multi-sentence narrative, not a
      // one-liner. Helios voice biomarkers need ~15s of audio to be
      // reliable, so the prompt has to elicit it without feeling like an
      // interrogation.
      return `Tell me what's been going on — what brought you in today, when it started, and anything you've noticed.`;
    case "conversation":
      // J.A.C.K.I.E. drives this phase — TTS comes from `jackie_turn`
      // events, not a fixed prompt.
      return "";
    default:
      return "";
  }
}

function phasePrompt(phase) {
  switch (phase) {
    case "first_name":
      return { label: "Step 1 of 5", title: "What's your first name?" };
    case "last_name":
      return { label: "Step 2 of 5", title: "And your last name?" };
    case "dob":
      return { label: "Step 3 of 5", title: "And your date of birth?" };
    case "complaint":
      return {
        label: "Step 4 of 5",
        title: "Tell me more about your concerns.",
      };
    case "conversation":
      // The actual title is replaced at render time with J.A.C.K.I.E.'s
      // current question (see Interview component).
      return { label: "Step 5 of 5", title: "Just a few more questions." };
    default:
      return { label: "", title: "" };
  }
}

function confirmTTS(voice, phase, value) {
  if (phase === "first_name") return `${value} — that right?`;
  if (phase === "last_name") return `${value} — that right?`;
  if (phase === "dob") return `${value} — is that right?`;
  return "";
}

// Short retry prompts — when the parse failed or the patient said "no" on
// the confirm card. Crisp; the patient already heard the long intro.
function phaseRetryTTS(voice, phase) {
  switch (phase) {
    case "first_name":
      return "Sorry — what's your first name?";
    case "last_name":
      return "Sorry — and your last name?";
    case "dob":
      return "Sorry — your date of birth?";
    case "complaint":
      return "Tell me what's going on.";
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
const NAME_FILLER = /^(hi|hello|hey|yes|yeah|yep|no|nope|nah|ok|okay|sure|well|uh|um|so|hi there|hello there|good morning|good afternoon|good evening)\b[\s,]*/i;
const NAME_ANNOUNCE = /^(my full name is|my name is|my name's|i'?m|i am|this is|it'?s|name is|name's|they call me|the name'?s|call me)\b[\s,]*/i;
const NAME_STOP_WORDS = new Set([
  "and", "but", "for", "with", "i", "im", "ill", "ive",
  "have", "got", "feeling", "feel", "experiencing", "here",
  "from", "to", "of", "the", "a",
]);
// Tokens that look name-shaped (2+ alphabetic chars) but aren't names —
// pronouns, connectors, common verbs. If the captured tokens are ALL
// from this set, the patient probably wasn't introducing themselves
// (e.g. they said "no it is..." trying to reject a prior misheard name).
// Reject the parse so the retry prompt fires instead of silently
// confirming "No It Is" as a name.
const NON_NAME_TOKENS = new Set([
  "no", "yes", "nope", "yeah",
  "it", "is", "isnt", "its",
  "this", "that", "those", "these",
  "you", "we", "they", "us", "them", "him", "her", "me",
  "what", "when", "where", "why", "how",
  "be", "do", "are", "am", "was", "were",
  "thanks", "thank",
]);

function parseName(raw) {
  if (!raw) return { ok: false, message: "I didn’t catch a name." };

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
  // or anything that doesn’t look like part of a name.
  const isNameWord = (t) => /^[A-Za-zÀ-ÿ’’\-]{2,}$/.test(t);
  const nameTokens = [];
  for (const tok of cleaned.split(" ")) {
    const lower = tok.toLowerCase().replace(/’/g, "");
    if (NAME_STOP_WORDS.has(lower)) break;
    if (!isNameWord(tok)) continue;
    nameTokens.push(tok);
    if (nameTokens.length >= 4) break;
  }

  // Dedupe BEFORE the count check, so "Janelle Janelle" still fails the
  // first+last requirement, and "Janelle Tamayo Janelle Tamayo" passes as
  // "Janelle Tamayo".
  const deduped = dedupeRepeatedSequence(nameTokens);
  // Accept single-word nicknames — patients may give a nickname instead of
  // their legal name, and that’s fine for triage purposes.
  if (deduped.length < 1) {
    return { ok: false, message: "I didn’t catch a name." };
  }
  // Reject "names" that are entirely common English words (pronouns,
  // connectors, rejection words). E.g. patient says "no it is" trying
  // to correct a prior misheard name — without this check, parseName
  // would happily return value: "No It Is" and ask them to confirm it.
  if (deduped.every((t) => NON_NAME_TOKENS.has(t.toLowerCase().replace(/'/g, "")))) {
    return { ok: false, message: "I didn’t catch a name." };
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

// Patterns for patient refusing DOB or giving age instead.
const DOB_REFUSAL = /\b(i\s+don'?t\s+(want|wish)\s+to|i'?d?\s+rather\s+not|no\s+thank|skip|pass|prefer\s+not|not\s+giving|refuse)\b/i;
const AGE_PATTERN = /\b(?:i'?m|i\s+am|age)?\s*(\d{1,3})\s*(?:years?\s*old|yrs?\s*old|y\.?o\.?)?\b/i;
const AGE_SPOKEN = /\b(?:i'?m|i\s+am)\s+(\d{1,3})\b/i;

function parseDOB(raw) {
  if (!raw) return { ok: false, message: "I didn't catch a date." };

  // Patient refuses to give DOB → accept as "Not provided".
  if (DOB_REFUSAL.test(raw)) {
    return { ok: true, value: "Not provided", skipped: true };
  }

  // Patient gives age instead of DOB ("I'm 54") → calculate approximate year.
  const ageMatch = raw.match(AGE_PATTERN) || raw.match(AGE_SPOKEN);
  if (ageMatch) {
    const age = parseInt(ageMatch[1], 10);
    if (age > 0 && age <= 120) {
      const approxYear = new Date().getFullYear() - age;
      return { ok: true, value: `~${approxYear} (age ${age})`, fromAge: true, age };
    }
  }

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

// Spell-out fallback: parse a transcript made of single letters
// ("J. A. N. E.") into a contiguous string ("JANE"). Tokens longer than
// one alphabetic character are dropped — patients sometimes throw in
// filler ("Uh, J. A.") or phonetic-alphabet hints ("J as in juliet")
// which we can't reliably parse, so single-letter tokens win.
function extractSpelledLetters(transcript) {
  if (!transcript) return "";
  return transcript
    .split(/[\s,.\-]+/)
    .map((tok) => tok.trim().replace(/\.$/, ""))
    .filter((tok) => /^[A-Za-z]$/.test(tok))
    .join("")
    .toUpperCase();
}

function titleCase(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Voice yes/no detection during the confirmation step. Loose patterns
// because Deepgram + the patient's accent + ER stress all degrade STT.
const YES_PATTERN = /\b(yes|yeah|yep|yup|correct|right|that'?s right|sounds right|confirm)\b/i;
const NO_PATTERN = /\b(no|nope|nah|wrong|not right|incorrect|that'?s wrong)\b/i;

function isMinorFromDOB(dobValue) {
  if (!dobValue || dobValue === "Not provided") return false;
  const ageMatch = dobValue.match(/age\s+(\d+)/);
  if (ageMatch) return parseInt(ageMatch[1], 10) < 18;
  const yearMatch = dobValue.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    const age = new Date().getFullYear() - parseInt(yearMatch[1], 10);
    return age < 18;
  }
  return false;
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
  // J.A.C.K.I.E. follow-up loop state
  const [jackieTurn, setJackieTurn] = useState(null); // { text, turn, max_turns, closing, emergency }
  const [triageComplete, setTriageComplete] = useState(false);
  // Patient-safety: triage_emergency event payload, when fired.
  const [emergency, setEmergency] = useState(null);  // { label, severity, matched_phrase }
  // Noisy environment: track consecutive low-confidence events.
  const [noisyEnvironment, setNoisyEnvironment] = useState(false);
  const lowConfCountRef = useRef(0);
  // Processing indicator: "thinking" (LLM composing JACKIE turn) or
  // "got_it" (200ms flash after speech committed) or null.
  const [processingState, setProcessingState] = useState(null);
  // Spell-out fallback for misheard names. When true, transcript
  // accumulation parses single-letter tokens instead of words.
  const [spellingMode, setSpellingMode] = useState(false);
  // Silence-based auto-commit timer. Identity phases call handleStopMic
  // automatically when partials stop arriving for ~1200ms (or 2500ms
  // for the open-ended complaint phase).
  const silenceTimerRef = useRef(null);
  // "Still listening…" visual indicator for the complaint phase.
  // Set true when a partial hasn't arrived for ~1500ms, so the patient
  // gets a soft "I'm still here, take your time" cue BEFORE the silence
  // timer commits at 2500ms. Cleared on every new partial.
  const [stillListening, setStillListening] = useState(false);
  const lastTranscriptUpdateAtRef = useRef(0);
  const stillListeningTimerRef = useRef(null);
  // Track how many times the patient has retried the last_name phase.
  // After 2 failures we skip and let the clinician fill it in via the
  // editable identity card. Avoids derailing the demo on a hard surname.
  const lastNameAttemptsRef = useRef(0);
  const phase = PHASES[phaseIdx];

  // Patient-facing persona name. Resolved from the voice they picked at
  // intake; used in every user-facing label so the dotted-name swarm
  // (V.I.C.T.O.R., M.E.R.C.E.D., S.C.R.I.B.E., …) never leaks to the
  // patient. Clinician dashboard sees the real agent names.
  const personaName = voice === "jackie" ? "Jackie" : "Victor";

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
  // Refs that onEvent needs to call but are defined later in the component.
  // Late-bound (set in the effect below) so the WS callback always sees
  // the current playTTS / mic-start / mic-stop / commit / confirm handlers.
  // The pattern exists because onEvent is memoized with [] deps to avoid
  // re-subscribing the WS on every state change; refs let it see fresh
  // closures without breaking that.
  const playTTSRef = useRef(null);
  const micStartRef = useRef(null);
  const micStopRef = useRef(null);
  const handleStopMicRef = useRef(null);
  const onConfirmYesRef = useRef(null);
  const onConfirmRetryRef = useRef(null);
  const confirmRef = useRef(null);
  const spellingModeRef = useRef(false);
  const audioRef = useRef(null);
  const ttsStateRef = useRef("idle");

  const onEvent = useCallback((evt) => {
    // ───────────── noise detection ─────────────
    if (evt.type === "jackie_turn" && evt.data?.low_confidence) {
      lowConfCountRef.current += 1;
      if (lowConfCountRef.current >= 2) setNoisyEnvironment(true);
    } else if (evt.type === "transcript" && evt.data?.is_final) {
      lowConfCountRef.current = 0;
      setNoisyEnvironment(false);
    }

    // ───────────── agent activity → "Persona is thinking…" ─────────────
    // Backend emits agent_activity for J.A.C.K.I.E. when the LLM is
    // composing the next follow-up. We surface this to the patient
    // under their chosen persona name (Victor / Jackie), never the
    // dotted-name swarm.
    if (evt.type === "agent_activity") {
      const a = evt.data || {};
      if (a.agent === "J.A.C.K.I.E." && a.status === "active") {
        setProcessingState("thinking");
      }
      // Other agents (M.E.R.C.E.D., S.C.R.I.B.E., V.I.C.T.O.R., E.L.M.E.R.)
      // are intentionally invisible to the patient — clinician sees them.
      return;
    }

    // ───────────── J.A.C.K.I.E. follow-up turn → play TTS ─────────────
    if (evt.type === "jackie_turn" && evt.data?.text) {
      const data = evt.data;
      setJackieTurn({
        text: data.text,
        turn: data.turn,
        max_turns: data.max_turns,
        closing: !!data.closing,
      });
      // TTS is starting — clear "thinking" state.
      setProcessingState("speaking");
      // Reset the running transcript so the patient's reply starts fresh.
      phaseTextRef.current = "";
      lastFinalRef.current = "";
      setInterimText("");
      const fn = playTTSRef.current;
      if (fn) fn(data.text, () => {
        setProcessingState(null);
        if (data.closing) return; // triage_complete will move us to done
        // 150ms handoff beat before flipping to "Listening" — avoids
        // jarring instant cutover from speaking → listening.
        const startFn = micStartRef.current;
        if (startFn) setTimeout(() => startFn(), 250);
      });
      return;
    }

    if (evt.type === "triage_complete") {
      setTriageComplete(true);
      return;
    }

    if (evt.type === "triage_emergency" && evt.data) {
      setEmergency({
        label: evt.data.label,
        severity: evt.data.severity || "ESI-1",
        matched_phrase: evt.data.matched_phrase,
      });
      const stopFn = micStopRef.current;
      if (stopFn) stopFn();
      return;
    }

    // ───────────── transcript handling ─────────────
    if (evt.type !== "transcript" || !evt.data?.text) return;
    const text = evt.data.text.trim();
    if (!text) return;

    // Barge-in: if the patient starts speaking while TTS is playing,
    // pause the audio so we don't talk over them. Threshold of 2 chars
    // avoids cancelling on stray noise blips.
    if (BARGE_IN_ENABLED && ttsStateRef.current === "speaking" && audioRef.current && text.length >= 2) {
      try { audioRef.current.pause(); } catch {}
      audioRef.current = null;
      setTtsState("done");
    }

    setInterimText(text);
    if (!evt.data.is_final) return;

    // ───────────── voice yes/no during confirmation ─────────────
    // The confirm card shows Yes/No buttons but voice should also work
    // — the patient's been talking the whole intake.
    if (confirmRef.current) {
      if (YES_PATTERN.test(text)) {
        const yesFn = onConfirmYesRef.current;
        if (yesFn) yesFn();
        return;
      }
      if (NO_PATTERN.test(text)) {
        const noFn = onConfirmRetryRef.current;
        if (noFn) noFn();
        return;
      }
      // Neither yes nor no — fall through and let it accumulate, but
      // don't auto-commit (the timer below is gated on !confirmRef.current).
    }

    const p = phaseRef.current;
    // Skip if Deepgram re-emits the same final segment.
    if (text === lastFinalRef.current) return;
    if (phaseTextRef.current && phaseTextRef.current.endsWith(text)) return;

    // ───────────── transcript accumulation ─────────────
    if (spellingModeRef.current && (p === "first_name" || p === "last_name")) {
      // In spelling fallback: parse single-letter tokens, join into a
      // contiguous string. The TranscriptCard renders this with mono
      // letter-spacing so the patient sees the name being assembled.
      // (Bug fix: previously gated on p === "name" which stopped
      // matching after we split into first_name + last_name — the raw
      // spelled "T A M A Y O" then bypassed the parser, got titleCased
      // to "T a m a y o", and ElevenLabs read it back letter-by-letter.)
      const accumulatedRaw = (phaseTextRef.current ? phaseTextRef.current + " " : "") + text;
      const letters = extractSpelledLetters(accumulatedRaw);
      phaseTextRef.current = letters; // already uppercase
    } else {
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
    }
    lastFinalRef.current = text;
    // Clear interim — it represented the in-flight version of THIS final;
    // now that the final is captured, the next utterance will set a fresh
    // interim. Without this, the display can briefly double-show the
    // tail of the prior utterance.
    setInterimText("");
    setAnswers((a) => ({ ...a, [p]: phaseTextRef.current }));

    // ───────────── conversation phase: stop mic to free worklet ─────────────
    if (p === "conversation") {
      setProcessingState("thinking");  // optimistic — backend agent_activity confirms
      setTimeout(() => {
        const stopFn = micStopRef.current;
        if (stopFn) stopFn();
      }, 80);
      return;
    }

    // ───────────── silence handling: phase-dependent ─────────────
    // Identity phases (first_name / last_name / dob) are short answers,
    // so silence at ~1200ms commits via handleStopMic (parse + confirm).
    //
    // Complaint phase is OPEN-ENDED — patients articulate over multiple
    // breaths ("I'm having stomach pains... and nausea... started two
    // days ago"). Auto-committing on a thinking-pause stops the mic and
    // loses the rest of their thought. So for complaint we DO NOT
    // auto-commit; the mic stays open until the patient explicitly taps
    // it (or the backend's 60s/180s session-abandonment safety net
    // kicks in). New finals naturally accumulate via the logic above.
    //
    // The "Still listening…" pill (1500ms) and "Tap mic when you're
    // done" hint (3000ms) provide visual reassurance without ending
    // the recording.
    if ((p === "first_name" || p === "last_name" || p === "dob") && !confirmRef.current) {
      lastTranscriptUpdateAtRef.current = Date.now();
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        if (phaseTextRef.current) {
          const commitFn = handleStopMicRef.current;
          if (commitFn) commitFn();
        }
      }, 1200);
    } else if (p === "complaint" && !confirmRef.current) {
      lastTranscriptUpdateAtRef.current = Date.now();
      setStillListening(false);  // new partial → reset "stale" indicator
      if (stillListeningTimerRef.current) clearTimeout(stillListeningTimerRef.current);
      // Show the soft "Still listening…" cue at 1500ms — does NOT commit.
      stillListeningTimerRef.current = setTimeout(() => {
        setStillListening(true);
      }, 1500);
    }
  }, []);

  const { status, sendBinary, send } = useWebSocket(wsUrl, { onEvent });

  const onFrame = useCallback(
    (buf) => {
      if (sendBinary(buf)) setFramesSent((n) => n + 1);
    },
    [sendBinary]
  );

  const { state: micState, start, stop } = useAudioCapture({ onFrame });

  const [ttsState, setTtsState] = useState("idle");

  const playTTS = useCallback((text, onEnded) => {
    if (!text || !voice) {
      if (typeof onEnded === "function") setTimeout(onEnded, 100);
      return;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const url = `${HTTP_BASE}/api/tts?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}`;

    // Try fetching — if server returns fallback JSON, use Web Speech API.
    fetch(url).then(async (res) => {
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json") || res.headers.get("X-TTS-Fallback")) {
        // ElevenLabs unavailable — fall back to browser Web Speech API.
        speakWithWebSpeechAPI(text, onEnded);
        return;
      }
      // Normal audio stream — play as before.
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const audio = new Audio(blobUrl);
      audioRef.current = audio;
      setTtsState("speaking");
      let settled = false;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        setTtsState(status);
        URL.revokeObjectURL(blobUrl);
        if (typeof onEnded === "function") onEnded();
      };
      audio.addEventListener("ended", () => finish("done"));
      audio.addEventListener("error", () => finish("error"));
      audio.play().catch(() => finish("error"));
    }).catch(() => {
      // Network error — fall back to Web Speech API.
      speakWithWebSpeechAPI(text, onEnded);
    });
  }, [voice]);

  const speakWithWebSpeechAPI = useCallback((text, onEnded) => {
    setTtsState("speaking");
    if (!window.speechSynthesis) {
      // No Web Speech API either — just show text, advance after delay.
      setTimeout(() => {
        setTtsState("done");
        if (typeof onEnded === "function") onEnded();
      }, Math.min(text.length * 50, 3000));
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.onend = () => {
      setTtsState("done");
      if (typeof onEnded === "function") onEnded();
    };
    utterance.onerror = () => {
      setTtsState("error");
      if (typeof onEnded === "function") onEnded();
    };
    window.speechSynthesis.speak(utterance);
  }, []);

  // Late-bind so onEvent (registered with useWebSocket once) always uses
  // the current versions of these callbacks.
  useEffect(() => {
    playTTSRef.current = playTTS;
    micStartRef.current = start;
    micStopRef.current = stop;
  }, [playTTS, start, stop]);

  // Sync state-mirror refs so the memoized onEvent closure can read them
  // without re-subscribing the WS on every state change. The handler refs
  // (handleStopMicRef, onConfirmYesRef, onConfirmRetryRef) are bound later
  // in a second effect after their callbacks are defined, to avoid TDZ.
  useEffect(() => { ttsStateRef.current = ttsState; }, [ttsState]);
  useEffect(() => { confirmRef.current = confirm; }, [confirm]);
  useEffect(() => { spellingModeRef.current = spellingMode; }, [spellingMode]);

  // When the backend signals triage complete, end the session.
  useEffect(() => {
    if (!triageComplete) return;
    const t = setTimeout(() => {
      stop();
      setStep("done");
    }, 1200); // brief pause so the closing TTS can finish
    return () => clearTimeout(t);
  }, [triageComplete, stop]);

  // Play the question prompt whenever the active phase changes, then
  // auto-start the mic so the patient never has to tap to begin.
  useEffect(() => {
    if (step !== "interview" || !voice) return;
    if (confirm) return; // don't replay the question while we're confirming
    const prompt = phaseTTS(voice, phase);
    if (!prompt) return; // conversation phase — JACKIE drives its own TTS
    playTTS(prompt, () => {
      // 250ms beat for a natural handoff (matches conversation flow).
      setTimeout(() => {
        const startFn = micStartRef.current;
        if (startFn) startFn();
      }, 250);
    });
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
    // first_name + last_name are captured separately, then combined into
    // `name` once last_name is confirmed (or skipped). Downstream consumers
    // see only the combined `name` field.
    setAnswers({ first_name: "", last_name: "", name: "", dob: "", complaint: "" });
    lastNameAttemptsRef.current = 0;
    phaseTextRef.current = "";
    lastFinalRef.current = "";
    setInterimText("");
    setConfirm(null);
    setParseError("");
    // Reset the cross-view store at the start of a new interview.
    clearIdentity();
  };

  // Helper: queue mic auto-restart after a TTS prompt finishes. Used by
  // every commit path so the patient stays hands-free.
  const scheduleMicRestart = useCallback(() => {
    setTimeout(() => {
      const startFn = micStartRef.current;
      if (startFn) startFn();
    }, 250);
  }, []);

  // User commits speech (silence timer, "I'm done" tap, or mic toggle).
  // For name/DOB, parse + confirm; for complaint, save and wait for advance.
  const handleStopMic = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (stillListeningTimerRef.current) {
      clearTimeout(stillListeningTimerRef.current);
      stillListeningTimerRef.current = null;
    }
    setStillListening(false);
    stop();
    const captured = (phaseTextRef.current || interimText || "").trim();
    if (!captured) return;
    // 200ms "Got it" flash so the patient knows their speech registered
    // before "Persona is thinking…" appears.
    setProcessingState("got_it");
    setTimeout(() => setProcessingState((s) => s === "got_it" ? null : s), 250);

    if (phase === "first_name" || phase === "last_name") {
      // In spelling mode, the captured value is already letters → name.
      let value;
      if (spellingModeRef.current) {
        value = titleCase(captured);
      } else {
        const r = parseName(captured);
        if (!r.ok) {
          setParseError(r.message);
          // Hard skip path for last_name: after 2 failed attempts, give
          // up and let the clinician fill it in. Avoids derailing the
          // demo on a difficult surname.
          if (phase === "last_name") {
            lastNameAttemptsRef.current += 1;
            if (lastNameAttemptsRef.current >= 2) {
              setConfirm({ phase: "last_name", value: "" });
              playTTS(
                "That's okay — we'll skip the last name. The clinician can add it later.",
                scheduleMicRestart
              );
              phaseTextRef.current = "";
              lastFinalRef.current = "";
              setInterimText("");
              return;
            }
          }
          playTTS(phaseRetryTTS(voice, phase), scheduleMicRestart);
          phaseTextRef.current = "";
          lastFinalRef.current = "";
          setInterimText("");
          return;
        }
        value = r.value;
      }
      setParseError("");
      setConfirm({ phase, value });
      playTTS(confirmTTS(voice, phase, value), scheduleMicRestart);
    } else if (phase === "dob") {
      const r = parseDOB(captured);
      if (!r.ok) {
        setParseError(r.message);
        playTTS(phaseRetryTTS(voice, phase), scheduleMicRestart);
        phaseTextRef.current = "";
        lastFinalRef.current = "";
        setInterimText("");
        return;
      }
      setParseError("");
      if (r.skipped) {
        setConfirm({ phase: "dob", value: r.value });
        playTTS("Okay — skipping that. Moving on.", scheduleMicRestart);
      } else if (r.fromAge) {
        setConfirm({ phase: "dob", value: r.value });
        playTTS(`Around ${r.age} years old — that right?`, scheduleMicRestart);
      } else {
        setConfirm({ phase: "dob", value: r.value });
        playTTS(confirmTTS(voice, "dob", r.value), scheduleMicRestart);
      }
    } else {
      // complaint — keep the text as-is, no confirmation required
      setAnswers((a) => ({ ...a, complaint: captured }));
    }
  }, [phase, voice, stop, interimText, playTTS, scheduleMicRestart]);

  const onConfirmYes = useCallback(() => {
    if (!confirm) return;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    // Identity propagation: downstream consumers (clinician dashboard,
    // sessionLog, EvidenceReport) see ONE combined `name` field. We only
    // emit `name` after last_name confirms (or last_name is skipped) so
    // the dashboard never shows a half-captured "Janelle" then "Janelle
    // Tamayo" update.
    setAnswers((a) => {
      const next = { ...a, [confirm.phase]: confirm.value };
      if (confirm.phase === "last_name") {
        next.name = `${a.first_name || ""} ${confirm.value}`.trim();
      }
      return next;
    });
    if (confirm.phase === "last_name") {
      // Combine and emit the full name now. If last_name was skipped
      // (value === ""), we still emit just the first name as the `name`.
      const fullName = `${(answers.first_name || "")} ${confirm.value}`.trim();
      setStoreIdentity({ name: fullName });
      const identityData = { name: fullName };
      send && send({ type: "identity_update", data: identityData });
    } else if (confirm.phase === "dob") {
      setStoreIdentity({ dob: confirm.value });
      const identityData = { dob: confirm.value };
      if (isMinorFromDOB(confirm.value)) identityData.is_minor = true;
      send && send({ type: "identity_update", data: identityData });
    }
    // first_name confirms hold off on writing to identityStore — we'll
    // combine with last_name and emit a single `name` then.
    setConfirm(null);
    setSpellingMode(false);
    setParseError("");
    setInterimText("");
    phaseTextRef.current = "";
    lastFinalRef.current = "";
    if (phaseIdx < PHASES.length - 1) setPhaseIdx((i) => i + 1);
    else setStep("done");
  }, [confirm, phaseIdx, send, answers]);

  const onConfirmRetry = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    const rejectedPhase = confirm?.phase;
    const wasName = rejectedPhase === "first_name" || rejectedPhase === "last_name";
    const alreadySpellingMode = spellingModeRef.current;
    setConfirm(null);
    setParseError("");
    setInterimText("");
    phaseTextRef.current = "";
    lastFinalRef.current = "";
    setAnswers((a) => ({ ...a, [phase]: "" }));
    // Spell-out fallback: on the FIRST name rejection (either first or
    // last name), switch to letter-by-letter mode. After one round of
    // spelling, fall back to the standard retry on subsequent rejections
    // (avoids infinite spelling loop). For last_name, also count toward
    // the skip-after-2-failures cap.
    if (rejectedPhase === "last_name") {
      lastNameAttemptsRef.current += 1;
    }
    if (wasName && !alreadySpellingMode) {
      setSpellingMode(true);
      const which = rejectedPhase === "last_name" ? "last" : "first";
      const promptText = `Sorry — let's spell that out. Your ${which} name, letter by letter.`;
      playTTS(promptText, scheduleMicRestart);
    } else {
      playTTS(phaseRetryTTS(voice, phase), scheduleMicRestart);
    }
  }, [phase, voice, playTTS, confirm, scheduleMicRestart]);

  // Text input fallback — when mic is blocked, patient types instead.
  // Simulates a transcript event so the same parsing/confirm flow runs.
  const handleTextSubmit = useCallback((text) => {
    phaseTextRef.current = text;
    lastFinalRef.current = text;
    setInterimText(text);
    setAnswers((a) => ({ ...a, [phase]: text }));
    // For name/dob phases, trigger the same parse+confirm flow.
    if (phase === "first_name" || phase === "last_name") {
      const r = parseName(text);
      if (!r.ok) { setParseError(r.message); return; }
      setParseError("");
      setConfirm({ phase, value: r.value });
      playTTS(confirmTTS(voice, phase, r.value));
    } else if (phase === "dob") {
      const r = parseDOB(text);
      if (!r.ok) { setParseError(r.message); return; }
      setParseError("");
      setConfirm({ phase: "dob", value: r.value });
      if (r.skipped) playTTS("That's okay — we'll skip that.");
      else playTTS(confirmTTS(voice, "dob", r.value));
    }
    // For complaint/conversation, the text is just captured.
  }, [phase, voice, playTTS]);

  // Bind handler refs AFTER their useCallbacks are declared, so the
  // memoized onEvent closure can call them via ref without TDZ issues.
  useEffect(() => { handleStopMicRef.current = handleStopMic; }, [handleStopMic]);
  useEffect(() => { onConfirmYesRef.current = onConfirmYes; }, [onConfirmYes]);
  useEffect(() => { onConfirmRetryRef.current = onConfirmRetry; }, [onConfirmRetry]);

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

  // Patient taps "Restart" on the complaint phase — they realised they
  // want to redo their concern. Clear the captured text, replay the
  // phase prompt TTS, then auto-restart the mic. Identity (name/dob)
  // is preserved — they don't have to re-do those.
  const restartComplaint = useCallback(() => {
    stop();
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (stillListeningTimerRef.current) {
      clearTimeout(stillListeningTimerRef.current);
      stillListeningTimerRef.current = null;
    }
    setStillListening(false);
    phaseTextRef.current = "";
    lastFinalRef.current = "";
    setInterimText("");
    setAnswers((a) => ({ ...a, complaint: "" }));
    setStoreIdentity({ complaint: "" });
    send && send({ type: "identity_update", data: { complaint: "" } });
    // Replay the complaint prompt + auto-restart mic. Same chain the
    // initial phase-change effect uses.
    playTTS(phaseTTS(voice, "complaint"), scheduleMicRestart);
  }, [voice, stop, send, playTTS, scheduleMicRestart]);

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
            personaName={personaName}
            wsStatus={status}
            ttsState={ttsState}
            micState={micState}
            phase={phase}
            phaseIdx={phaseIdx}
            answers={answers}
            interimText={interimText}
            confirm={confirm}
            parseError={parseError}
            jackieTurn={jackieTurn}
            framesSent={framesSent}
            noisy={noisyEnvironment}
            processingState={processingState}
            spellingMode={spellingMode}
            stillListening={stillListening}
            onStart={start}
            onStopMic={handleStopMic}
            onCancel={stop}
            onAdvance={advancePhase}
            onRestart={restartComplaint}
            onConfirmYes={onConfirmYes}
            onConfirmRetry={onConfirmRetry}
            onTextSubmit={handleTextSubmit}
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
          color: "var(--vic-on-surface-variant)", fontSize: 10,
          fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.06em",
          opacity: 0.7,
        }}>
          Powered by AMD MI300X
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
        Let's get you seen.
      </h1>
      <p style={{
        color: "var(--vic-on-surface-variant)", fontSize: 18, lineHeight: 1.6,
        marginBottom: 24, fontWeight: 300,
      }}>
        Just a few quick questions out loud — it helps a clinician get to you faster.
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
  voice, personaName, wsStatus, ttsState, micState,
  phase, phaseIdx, answers, interimText, confirm, parseError, jackieTurn,
  framesSent, noisy, processingState, spellingMode, stillListening,
  onStart, onStopMic, onCancel, onAdvance, onConfirmYes, onConfirmRetry,
  onTextSubmit, onRestart,
}) {
  const recording = micState === "recording";
  const error = micState === "error";
  const speaking = ttsState === "speaking";
  const thinking = processingState === "thinking";
  const gotIt = processingState === "got_it";
  const { label: defaultLabel, title: defaultTitle } = phasePrompt(phase);
  const isConvo = phase === "conversation";
  const label = isConvo && jackieTurn
    ? `Question ${jackieTurn.turn} of ${jackieTurn.max_turns}`
    : defaultLabel;
  const title = isConvo && jackieTurn?.text ? jackieTurn.text : defaultTitle;
  const captured = answers[phase] || "";
  // Show the FULL accumulated answer plus the current interim partial
  // (if there's a new in-flight utterance not yet committed). Previously
  // we just used `interimText || captured` which threw away history the
  // moment a new partial arrived — patients said long complaints and
  // only saw the most recent sentence, hiding everything they'd already
  // built up.
  let liveText;
  if (!captured && !interimText) liveText = "";
  else if (!captured) liveText = interimText;
  else if (!interimText) liveText = captured;
  else if (captured.toLowerCase().endsWith(interimText.toLowerCase().trim())) liveText = captured;
  else liveText = `${captured} ${interimText}`;
  const isConfirming = !!confirm;
  const hasCaptured = !!captured.trim();

  let subline;
  if (isConfirming) subline = `Just say "yes" if that's right, or "no" to fix it.`;
  else if (gotIt) subline = "Got it — one second.";
  else if (thinking) subline = `${personaName} is putting a thought together.`;
  else if (speaking) subline = `${personaName} is talking — I'll listen as soon as ${personaName} finishes.`;
  else if (recording && spellingMode) subline = "Spell your first name out — one letter at a time.";
  else if (recording) subline = "Go ahead — I'm listening.";
  else if (parseError) subline = parseError;
  else if (isConvo && jackieTurn?.closing) subline = "All done — a clinician will be with you soon.";
  else if (isConvo) subline = "Take your time — answer when you're ready.";
  else if (captured && phase === "complaint") subline = `Thanks for sharing. Tap "I'm done" when you've said everything, or keep talking.`;
  else subline = "Just a moment — getting ready to listen.";

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
        {thinking && <ThinkingDots personaName={personaName} />}
      </div>

      {!isConfirming && (
        <MicCircle recording={recording} error={error} onClick={recording ? onStopMic : onStart} />
      )}

      {/* Soft "I'm still here" cue during the open-ended complaint phase.
          Appears when partials stop arriving for 1500ms but BEFORE the
          2500ms commit. Pure UI nudge — answers "did it hear me?" anxiety. */}
      {stillListening && phase === "complaint" && recording && (
        <StillListeningPill />
      )}

      {/* Topic-prompt chips on the complaint phase — gentle invitations
          to share more. Helps stressed/in-pain patients structure their
          thoughts and naturally produces longer speech (good for Helios
          biomarker accuracy). Hidden during TTS playback so it doesn't
          compete with what the persona is saying. */}
      {phase === "complaint" && !speaking && !isConfirming && (
        <ComplaintTopicChips />
      )}

      <StatusPill
        recording={recording}
        error={error}
        ttsState={ttsState}
        wsStatus={wsStatus}
        noisy={noisy}
        processingState={processingState}
        personaName={personaName}
      />

      {error && <MicErrorHelp onRetry={onStart} onTextSubmit={onTextSubmit} phase={phase} />}

      {isConfirming ? (
        <ConfirmCard confirm={confirm} onYes={onConfirmYes} onRetry={onConfirmRetry} />
      ) : (
        <TranscriptCard
          transcript={liveText}
          active={recording || speaking}
          phase={phase}
          spellingMode={spellingMode}
        />
      )}

      {!isConfirming && (
        <CommitButton
          phase={phase}
          recording={recording}
          hasCaptured={hasCaptured}
          processingState={processingState}
          ttsState={ttsState}
          personaName={personaName}
          onCommit={onStopMic}
          onCancel={onCancel}
          onAdvance={onAdvance}
          onRestart={onRestart}
        />
      )}

      <PrivacyNote />

      {showDebug() && (
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
          color: "var(--vic-on-surface-variant)", opacity: 0.6,
          textTransform: "uppercase", letterSpacing: "0.18em",
        }}>
          voice: {voice} · phase: {phase} · ws: {wsStatus} · tts: {ttsState} · frames: {framesSent}
          {spellingMode && " · spelling"}
          {processingState && ` · ${processingState}`}
        </div>
      )}
    </div>
  );
}

// "Persona is thinking…" 3-dot animation under the question card. Plays
// only while processingState === "thinking" so it doesn't compete with
// the listening or speaking visual states.
function ThinkingDots({ personaName }) {
  return (
    <div style={{
      marginTop: 14, display: "inline-flex", alignItems: "center", gap: 8,
      padding: "6px 14px", borderRadius: 999,
      background: "rgba(255, 185, 95, 0.08)",
      border: "1px solid rgba(255, 185, 95, 0.25)",
    }}>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
        color: "var(--vic-tertiary)", letterSpacing: "0.08em",
      }}>{personaName} is thinking</span>
      <span style={{ display: "inline-flex", gap: 3 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 4, height: 4, borderRadius: "50%",
              background: "var(--vic-tertiary)",
              animation: `vic-pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
            }}
          />
        ))}
      </span>
    </div>
  );
}

// Topic-prompt chips for the complaint phase — gentle invitations to
// help stressed patients structure what they want to share. Mapped to
// the OPQRST mnemonic that ED triage nurses actually use (Onset, Quality,
// Radiation, Severity, Time, Provocation) per ENA / SAEM standards.
// Plus one psychological-safety prompt ("What's worrying you most?")
// which research shows surfaces clinically important fears patients
// otherwise omit. Phrased as open questions, not a checklist.
//
// Sources informing this choice:
// - SAEM CDEM curriculum: complaint-directed history (OPQRST)
// - Emergency Nursing Association triage flashcards (OPQRST + SAMPLE)
// - 90% of diagnostic info is in the patient history (SAEM)
function ComplaintTopicChips() {
  const chips = [
    { Icon: Clock,         text: "When did it start?" },          // Onset
    { Icon: MessageCircle, text: "What does it feel like?" },     // Quality
    { Icon: Gauge,         text: "How bad is it, 1 to 10?" },     // Severity
    { Icon: Flag,          text: "What's worrying you most?" },   // patient-led concern
  ];
  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center",
      maxWidth: 720,
    }}>
      {chips.map(({ Icon, text }, i) => (
        <div
          key={i}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "6px 12px", borderRadius: 999,
            background: "rgba(47, 217, 244, 0.04)",
            border: "1px solid rgba(47, 217, 244, 0.15)",
            fontSize: 12, color: "var(--vic-on-surface-variant)",
            fontFamily: "'Inter', system-ui, sans-serif",
          }}
        >
          <Icon size={14} strokeWidth={2} />
          <span>{text}</span>
        </div>
      ))}
    </div>
  );
}

// Soft "I'm still here" pill — appears on the complaint phase when the
// patient pauses for ~1500ms but BEFORE the silence timer commits at
// 2500ms. Reassures them the mic hasn't given up. Disappears the
// moment a new partial arrives or the timer commits.
function StillListeningPill() {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      padding: "6px 14px", borderRadius: 999,
      background: "rgba(47, 217, 244, 0.06)",
      border: "1px solid rgba(47, 217, 244, 0.2)",
      marginTop: -8,  // pulls it closer to the mic circle
      animation: "vic-pulse 2s ease-in-out infinite",
    }}>
      <span style={{ fontSize: 14 }}>💭</span>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
        color: "var(--vic-on-surface-variant)", letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}>Still listening — take your time</span>
    </div>
  );
}

// Primary commit affordance for every voice phase. Replaces "tap mic to
// stop" as the patient's clear "I'm done" signal. State machine:
//   - listening + captured text → "I'm done →" (primary teal)
//   - listening + no text → "Cancel" (secondary outline)
//   - thinking / speaking → disabled status label
//   - complaint w/ captured text → "Continue — follow-up questions →"
//     (existing advance flow takes over)
function CommitButton({
  phase, recording, hasCaptured, processingState, ttsState, personaName,
  onCommit, onCancel, onAdvance, onRestart,
}) {
  const thinking = processingState === "thinking";
  const speaking = ttsState === "speaking";

  // Complaint phase, captured something → use the existing advance button
  // because we want to KEEP the captured text and move on, not re-parse.
  // Also offer a Restart so the patient can redo their concern from scratch
  // if they realised mid-thought they want a different framing.
  if (phase === "complaint" && hasCaptured && !recording && !thinking && !speaking) {
    return (
      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        <button onClick={onRestart} style={secondaryBtnStyle}>
          ↺ Restart
        </button>
        <button
          onClick={onAdvance}
          style={primaryBtnStyle(true)}
        >
          Continue — follow-up questions →
        </button>
      </div>
    );
  }

  // Processing or speaking → disabled with status text.
  if (thinking || speaking) {
    return (
      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        <button disabled style={primaryBtnStyle(false)}>
          {thinking ? `${personaName} is thinking…` : `${personaName} is speaking…`}
        </button>
      </div>
    );
  }

  // Recording with captured text → commit affordance. Label varies by phase:
  //   - Identity phases (first/last name, dob): "I'm done →" — short answers,
  //     committing immediately is what the patient expects.
  //   - Complaint phase: "Send →" — softer than "I'm done" so the patient
  //     doesn't feel they're committing to a final sentence; reads more like
  //     submitting a message they've finished writing. Sits alongside the
  //     mic-tap path (still works) so they have two ways to commit.
  if (recording && hasCaptured) {
    const label = phase === "complaint" ? "Send →" : "I'm done →";
    return (
      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        <button onClick={onCommit} style={primaryBtnStyle(true)}>
          {label}
        </button>
      </div>
    );
  }

  // Recording with no text yet → quiet Cancel option (skip if not recording).
  if (recording) {
    return (
      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        <button onClick={onCancel} style={secondaryBtnStyle}>
          Cancel
        </button>
      </div>
    );
  }

  // Idle (waiting for TTS to finish or for first auto-start) → no button.
  return null;
}

function primaryBtnStyle(enabled) {
  return {
    padding: "14px 36px", borderRadius: 999,
    background: enabled
      ? "linear-gradient(to right, var(--vic-primary), #008ea1)"
      : "var(--vic-bg-highest)",
    color: enabled ? "var(--vic-on-primary)" : "var(--vic-on-surface-variant)",
    fontWeight: 700, fontSize: 16,
    border: "none", cursor: enabled ? "pointer" : "not-allowed",
    boxShadow: enabled ? "0 8px 30px rgba(47, 217, 244, 0.3)" : "none",
    display: "flex", alignItems: "center", gap: 12,
    fontFamily: "'Space Grotesk', 'Inter', sans-serif",
    letterSpacing: "0.01em",
  };
}

const secondaryBtnStyle = {
  padding: "12px 28px", borderRadius: 999,
  background: "transparent",
  color: "var(--vic-on-surface-variant)",
  border: "1px solid rgba(255, 255, 255, 0.18)",
  fontWeight: 600, fontSize: 14, cursor: "pointer",
  fontFamily: "'Space Grotesk', 'Inter', sans-serif",
};

function PhaseStepper({ phaseIdx, answers }) {
  // 5 steps now (split first/last name). Slightly more granular but
  // honest about what's happening. The mono labels stay short to fit.
  const items = [
    { key: "first_name", label: "First name" },
    { key: "last_name", label: "Last name" },
    { key: "dob", label: "Date of birth" },
    { key: "complaint", label: "Reason for visit" },
    { key: "conversation", label: "Follow-up" },
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

function MicErrorHelp({ onRetry, onTextSubmit, phase }) {
  const [textInput, setTextInput] = useState("");
  const placeholders = {
    first_name: "Type your first name here...",
    last_name: "Type your last name here...",
    dob: "Type your date of birth (e.g. January 15, 1980)...",
    complaint: "Describe your symptoms here...",
    conversation: "Type your answer here...",
  };
  return (
    <div style={{
      maxWidth: 520, padding: "16px 20px", borderRadius: 12,
      background: "rgba(255, 180, 171, 0.08)",
      border: "1px solid rgba(255, 180, 171, 0.25)",
      color: "var(--vic-on-error-bg)", textAlign: "left",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        We couldn't access your microphone. You can either allow microphone
        access in your browser settings, or type your response below.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={onRetry}
          style={{
            padding: "8px 16px", borderRadius: 999,
            background: "var(--vic-error)", color: "var(--vic-error-bg)",
            border: "none", cursor: "pointer",
            fontWeight: 700, fontSize: 12,
            textTransform: "uppercase", letterSpacing: "0.1em",
          }}
        >
          Try mic again
        </button>
      </div>
      <div style={{
        display: "flex", gap: 8, marginTop: 8,
        borderTop: "1px solid rgba(255, 180, 171, 0.15)", paddingTop: 12,
      }}>
        <input
          type="text"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && textInput.trim()) {
              onTextSubmit(textInput.trim());
              setTextInput("");
            }
          }}
          placeholder={placeholders[phase] || "Type here..."}
          style={{
            flex: 1, padding: "10px 14px", borderRadius: 12,
            background: "rgba(21, 27, 45, 0.8)",
            border: "1px solid rgba(47, 217, 244, 0.3)",
            color: "var(--vic-on-surface)", fontSize: 14,
            outline: "none",
          }}
        />
        <button
          onClick={() => { if (textInput.trim()) { onTextSubmit(textInput.trim()); setTextInput(""); } }}
          disabled={!textInput.trim()}
          style={{
            padding: "10px 18px", borderRadius: 12,
            background: textInput.trim() ? "var(--vic-primary)" : "var(--vic-bg-highest)",
            color: textInput.trim() ? "var(--vic-on-primary)" : "var(--vic-on-surface-variant)",
            border: "none", cursor: textInput.trim() ? "pointer" : "not-allowed",
            fontWeight: 700, fontSize: 13,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function StatusPill({ recording, error, ttsState, wsStatus, noisy, processingState, personaName }) {
  let label, color, bg, border, animate;
  const persona = personaName || "Victor";
  if (error) {
    label = "Microphone permission denied";
    color = "var(--vic-error)";
    bg = "rgba(255, 180, 171, 0.1)";
    border = "rgba(255, 180, 171, 0.2)";
  } else if (processingState === "got_it") {
    label = "Got it";
    color = "var(--vic-primary)";
    bg = "rgba(47, 217, 244, 0.1)";
    border = "rgba(47, 217, 244, 0.2)";
  } else if (processingState === "thinking") {
    label = `${persona} is thinking…`;
    color = "var(--vic-tertiary)";
    bg = "rgba(255, 185, 95, 0.1)";
    border = "rgba(255, 185, 95, 0.25)";
    animate = true;
  } else if (noisy) {
    label = "It's quite loud — lean closer and speak clearly";
    color = "var(--vic-secondary)";
    bg = "rgba(47, 217, 244, 0.1)";
    border = "rgba(47, 217, 244, 0.2)";
  } else if (recording) {
    label = "Listening now…";
    color = "var(--vic-primary)";
    bg = "rgba(47, 217, 244, 0.1)";
    border = "rgba(47, 217, 244, 0.2)";
    animate = true;
  } else if (ttsState === "speaking") {
    label = `${persona} is speaking…`;
    color = "var(--vic-primary)";
    bg = "rgba(47, 217, 244, 0.1)";
    border = "rgba(47, 217, 244, 0.2)";
    animate = true;
  } else if (wsStatus === "open") {
    label = "One moment…";
    color = "var(--vic-on-surface-variant)";
    bg = "rgba(47, 217, 244, 0.06)";
    border = "rgba(47, 217, 244, 0.15)";
  } else if (wsStatus === "closed" || wsStatus === "error") {
    label = "Reconnecting…";
    color = "var(--vic-secondary)";
    bg = "rgba(192, 193, 255, 0.08)";
    border = "rgba(192, 193, 255, 0.2)";
  } else {
    label = `Connecting (${wsStatus})…`;
    color = "var(--vic-on-surface-variant)";
    bg = "rgba(47, 217, 244, 0.06)";
    border = "rgba(47, 217, 244, 0.15)";
  }

  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      padding: "8px 16px", borderRadius: 999,
      background: bg,
      border: `1px solid ${border}`,
      transition: "background 0.2s, border-color 0.2s",
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%", background: color,
        animation: animate ? "ping 1.5s infinite" : "none",
      }} />
      <span style={{
        color, fontSize: 12, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: "0.08em",
      }}>{label}</span>
    </div>
  );
}

function TranscriptCard({ transcript, active, phase, spellingMode }) {
  const empty = !transcript;
  const which = phase === "last_name" ? "last" : "first";
  const heading = spellingMode
    ? `Spelling — ${which === "last" ? "Last" : "First"} name`
    : phase === "first_name"
    ? "Heard — First name"
    : phase === "last_name"
    ? "Heard — Last name"
    : phase === "dob"
    ? "Heard — Date of birth"
    : phase === "complaint"
    ? "Heard — Reason for visit"
    : phase === "conversation"
    ? "Heard — Your answer"
    : "Live Transcription";
  const placeholder = spellingMode
    ? `Spell your ${which} name out loud — J … A … N … E …`
    : phase === "first_name"
    ? "Awaiting your first name…"
    : phase === "last_name"
    ? "Awaiting your last name…"
    : phase === "dob"
    ? "Awaiting your date of birth…"
    : phase === "complaint"
    ? "Awaiting your answer…"
    : phase === "conversation"
    ? "Take your time — I'll listen when you're ready…"
    : "Awaiting your voice…";

  return (
    <div className="vic-glass" style={{
      width: "100%", padding: 32, borderRadius: 32,
      border: `1px solid ${spellingMode ? "rgba(255, 185, 95, 0.25)" : "rgba(69, 70, 77, 0.15)"}`,
      boxShadow: "0 32px 64px -12px rgba(0, 0, 0, 0.5)",
      minHeight: 140,
    }}>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <span style={{
          color: spellingMode ? "var(--vic-tertiary)" : "var(--vic-primary)",
          fontSize: 22, marginTop: 4,
        }}>{spellingMode ? "🔤" : "✦"}</span>
        <div style={{ flex: 1 }}>
          <div style={{
            fontSize: 11, fontWeight: 700, textTransform: "uppercase",
            letterSpacing: "0.2em",
            color: spellingMode ? "rgba(255, 185, 95, 0.8)" : "rgba(47, 217, 244, 0.6)",
            marginBottom: 8,
          }}>
            {heading}
          </div>
          {spellingMode ? (
            <SpelledLetters value={transcript} placeholder={placeholder} />
          ) : (
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
          )}
        </div>
      </div>
    </div>
  );
}

function SpelledLetters({ value, placeholder }) {
  if (!value) {
    return (
      <p style={{
        fontSize: 18, lineHeight: 1.55, color: "var(--vic-on-surface-variant)",
        fontStyle: "italic", margin: 0, opacity: 0.6,
      }}>{placeholder}</p>
    );
  }
  const letters = value.split("");
  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline",
    }}>
      {letters.map((ch, i) => (
        <span
          key={i}
          style={{
            display: "inline-grid", placeItems: "center",
            minWidth: 36, height: 44,
            padding: "0 8px",
            borderRadius: 8,
            background: "rgba(255, 185, 95, 0.1)",
            border: "1px solid rgba(255, 185, 95, 0.3)",
            fontFamily: "'Space Grotesk', sans-serif",
            fontSize: 26, fontWeight: 700,
            color: "var(--vic-on-surface)",
            letterSpacing: "0.02em",
          }}
        >
          {ch}
        </span>
      ))}
      <span style={{
        marginLeft: 12,
        fontFamily: "'Inter', sans-serif",
        fontSize: 14, color: "var(--vic-on-surface-variant)",
      }}>
        → <strong style={{ color: "var(--vic-on-surface)", fontWeight: 600 }}>{titleCase(value)}</strong>
      </span>
    </div>
  );
}

function ConfirmCard({ confirm, onYes, onRetry }) {
  const heading =
    confirm.phase === "first_name"
      ? "Just want to make sure I got your first name right."
      : confirm.phase === "last_name"
      ? confirm.value
        ? "And your last name — did I get this right?"
        : "Skipping your last name — the clinician can add it later."
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
