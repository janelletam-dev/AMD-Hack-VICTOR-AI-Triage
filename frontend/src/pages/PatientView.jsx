import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { Clock, MessageCircle, Gauge, Flag, Venus, Mars } from "lucide-react";
import VoiceSelector from "../components/VoiceSelector.jsx";
import AMDStatusPill from "../components/vic/AMDStatusPill.jsx";
import { useWebSocket } from "../hooks/useWebSocket.js";
import { useAudioCapture } from "../hooks/useAudioCapture.js";
import { setIdentity as setStoreIdentity, clearIdentity, useIdentity } from "../state/identityStore.js";
import { HTTP_BASE, WS_BASE } from "../lib/backend-urls.js";

// `conversation` is J.A.C.K.I.E.'s adaptive follow-up loop. It's not a
// fixed step like the prior three — the agent drives one question at a time
// from the backend via `jackie_turn` events until `triage_complete` fires.
// Name capture is split into first_name + last_name because STT accuracy
// on a single common word is ~95% vs ~60-70% on a full name (especially
// non-Anglo surnames). The two captured pieces are joined back into a
// single `name` field for downstream consumers (identityStore,
// sessionLog, EvidenceReport — those don't change shape).
const PHASES = ["first_name", "last_name", "dob", "gender", "complaint", "conversation"];

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
    case "gender":
      // Button-driven, not voice-driven. Voice prompt names the options
      // out loud so visually-impaired patients can hear them; the kiosk
      // shows the buttons regardless.
      //
      // Sex assigned at birth (not gender identity) is the clinically
      // load-bearing field for ED triage: it changes differential
      // diagnosis priors (chest pain in F vs M), drug dosing, lab
      // reference ranges (Hgb / Cr / troponin), and imaging protocols
      // (pregnancy gating). Per HL7 FHIR + Joint Commission, sex at
      // birth and gender identity are separate fields — for a 5-min
      // demo we capture only the clinically required one.
      return `One quick thing — for accurate clinical decisions, what was your sex at birth? Tap female or male.`;
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
      return { label: "Step 1 of 6", title: "What's your first name?" };
    case "last_name":
      return { label: "Step 2 of 6", title: "And your last name?" };
    case "dob":
      return { label: "Step 3 of 6", title: "And your date of birth?" };
    case "gender":
      // "Sex assigned at birth" is the clinically load-bearing label —
      // see phaseTTS comment for rationale. Capturing this (not gender
      // identity) is what the ED triage agents actually need.
      return { label: "Step 4 of 6", title: "What was your sex assigned at birth?" };
    case "complaint":
      return {
        label: "Step 5 of 6",
        title: "Tell me more about your concerns.",
      };
    case "conversation":
      // The actual title is replaced at render time with J.A.C.K.I.E.'s
      // current question (see Interview component).
      return { label: "Step 6 of 6", title: "Just a few more questions." };
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
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Patterns for patient refusing DOB or giving age instead.
const DOB_REFUSAL = /\b(i\s+don'?t\s+(want|wish)\s+to|i'?d?\s+rather\s+not|no\s+thank|skip|pass|prefer\s+not|not\s+giving|refuse)\b/i;
// AGE detection requires a prefix ("I'm", "I am", "age") OR a suffix
// ("years old", "yo") around the number — otherwise a date like
// "13 April 1990" false-matches "13" as age 13 and short-circuits the
// real DOB parser. Three-clause pattern: (prefix path | suffix path |
// "age <n>" literal). Capture group 1, 2, or 3 carries the digits.
const AGE_PATTERN = /\b(?:i'?m|i\s+am)\s+(\d{1,3})(?!\s*\d)\b|\b(\d{1,3})\s*(?:years?\s+old|yrs?\s+old|y\.?o\.?)\b|\bage\s+(\d{1,3})\b/i;

function parseDOB(raw) {
  if (!raw) return { ok: false, message: "I didn't catch a date." };

  // Patient refuses to give DOB → accept as "Not provided".
  if (DOB_REFUSAL.test(raw)) {
    return { ok: true, value: "Not provided", skipped: true };
  }

  // Patient gives age instead of DOB ("I'm 54", "30 years old", "age 30")
  // → calculate approximate year. We test BOTH the raw text and the
  // wordsToNumbers-normalised version so spoken numbers ("I'm thirty")
  // also catch.
  const tryAge = (s) => {
    const m = s.match(AGE_PATTERN);
    if (!m) return null;
    const digits = m[1] || m[2] || m[3];
    if (!digits) return null;
    const age = parseInt(digits, 10);
    if (age > 0 && age <= 120) {
      const approxYear = new Date().getFullYear() - age;
      return { ok: true, value: `~${approxYear} (age ${age})`, fromAge: true, age };
    }
    return null;
  };
  const ageRaw = tryAge(raw);
  if (ageRaw) return ageRaw;
  const ageNorm = tryAge(wordsToNumbers(raw));
  if (ageNorm) return ageNorm;

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

  // 2) Word month: "January 15 1980", "15 January 1980", "Jan 15th, 1980".
  // Also accept partials: year+month (no day) and year-only — drop the
  // patient into the editable date picker with a sensible starting
  // value rather than rejecting the whole utterance. STT misses days
  // constantly ("April 1990" was the original failure case in testing)
  // and forcing the patient to repeat the entire DOB wastes time when
  // we got most of it right.
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
  // Partial: month + year, no day → default to day 1 and let the
  // patient adjust in the date picker. partial=true so the caller can
  // optionally surface a hint like "I caught April 1990 — pick the day".
  if (mw && yearMatch) {
    const m = MONTH_WORDS[mw[1].toLowerCase()];
    const y = parseInt(yearMatch[1], 10);
    if (isValidYMD(y, m, 1)) return { ok: true, value: formatYMD(y, m, 1), partial: true };
  }
  // Partial: year only → default to Jan 1.
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10);
    if (isValidYMD(y, 1, 1)) return { ok: true, value: formatYMD(y, 1, 1), partial: true };
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
  // step = "welcome" | "nurse" | "select" | "verify" | "interview" | "done"
  // The "nurse" + "verify" steps are an optional fast-path: a triage nurse
  // who already knows the patient (e.g. arrived by ambulance, EMR pull,
  // returning patient) types name + DOB up-front, then the patient just
  // confirms "yes that's me" with a single tap and skips straight to the
  // sex-at-birth question. Skipping voice name/DOB capture removes the
  // single biggest source of friction in the kiosk flow (mishears,
  // spelling fallback, DOB parsing).
  const [step, setStep] = useState("welcome");
  // Nurse-supplied identity, holds first_name / last_name / dob until
  // the patient confirms or rejects on the verify screen.
  const [prefill, setPrefill] = useState(null);
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
  // Noisy environment: tracked via TWO signals.
  //   1. Reactive (lagging): JACKIE returns low-confidence transcripts twice
  //      in a row → setNoisyEnvironment(true). Fires after the patient has
  //      already failed to be heard, so it's late.
  //   2. Proactive (real-time): WebAudio AnalyserNode reads RMS level on
  //      the post-suppression mic signal at 10Hz. If level is consistently
  //      loud (> 0.55 on a 0..1 normalised scale) for >2s, we flip the
  //      noisy state immediately — patient sees the warning before the
  //      first failed turn. Threshold tuned for ER ambient post-WebRTC NS.
  const [noisyEnvironment, setNoisyEnvironment] = useState(false);
  const [noiseLevel, setNoiseLevel] = useState(0);  // 0..1, 10Hz
  const lowConfCountRef = useRef(0);
  const loudSinceRef = useRef(null);
  const onNoiseLevel = useCallback((level) => {
    setNoiseLevel(level);
    const now = Date.now();
    if (level > 0.55) {
      if (loudSinceRef.current === null) loudSinceRef.current = now;
      // Sustained loud for 2s → trigger proactive warning.
      if (now - loudSinceRef.current > 2000) setNoisyEnvironment(true);
    } else {
      loudSinceRef.current = null;
    }
  }, []);
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
  // Editable accumulating transcript for the complaint phase. Each
  // finalised utterance appends; the patient can edit the textarea
  // directly to fix mistranscriptions before tapping Send. Sidesteps
  // the in-place accumulation magic — what you see is what gets sent.
  // Other phases stay on the captured/interim model because their
  // answers are short.
  const [complaintDraft, setComplaintDraft] = useState("");
  // Per-turn editable answer for the conversation phase. Same pattern
  // as complaintDraft — finals append and the patient can edit before
  // tapping Send. Resets to "" each time J.A.C.K.I.E. asks a new
  // question so the box is always fresh for the patient's reply.
  const [conversationDraft, setConversationDraft] = useState("");
  // Running log of JACKIE↔patient turns during the conversation phase.
  // Renders as a small scrollable history above the editable textarea
  // so a stressed/distracted patient can see what was just asked and
  // what they already said — particularly useful when JACKIE asks a
  // multi-part question and the patient forgets the second half. Each
  // entry: {role: "jackie"|"patient", text, turn}. Capped to keep
  // memory bounded; the full history still flows to the backend for
  // SCRIBE / V.I.C.T.O.R. via state["jackie_history"].
  const [conversationLog, setConversationLog] = useState([]);
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
  // AbortController tracking in-flight TTS fetches so a fresh playTTS
  // call can hard-cancel anything stale before issuing its own request.
  // Without this, a previous fetch resolving late can stomp audioRef
  // with the wrong audio object and either play overlapping prompts or
  // break the ended-event chain that drives mic auto-start (the smoking
  // gun for the gender → complaint stall reported during testing).
  const ttsAbortRef = useRef(null);
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
      // Append the just-arrived JACKIE question to the on-screen
      // conversation log so the patient (and an observing clinician)
      // can scroll back through the dialogue. Clip to last 20 entries
      // to keep DOM size bounded — full history lives backend-side.
      setConversationLog((prev) => {
        const next = [...prev, { role: "jackie", text: data.text, turn: data.turn }];
        return next.length > 20 ? next.slice(-20) : next;
      });
      // TTS is starting — clear "thinking" state.
      setProcessingState("speaking");
      // Reset the running transcript so the patient's reply starts fresh.
      phaseTextRef.current = "";
      lastFinalRef.current = "";
      setInterimText("");
      // New JACKIE question → clear the conversation textarea so the
      // patient sees a fresh empty box for their answer (same UX
      // pattern as the complaint phase). Without this the prior
      // answer would still be displayed and confuse the next turn.
      setConversationDraft("");
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

    // For the complaint phase: append this final to the editable
    // textarea draft so the patient sees their full statement
    // accumulating in plain view. They can edit it before tapping Send.
    // Functional updater avoids stale-closure issues if multiple finals
    // arrive in quick succession.
    if (p === "complaint") {
      setComplaintDraft((prev) => {
        const trimmed = text.trim();
        if (!trimmed) return prev;
        if (!prev) return trimmed;
        // Skip if Deepgram echoed exactly the same final twice
        if (prev.endsWith(trimmed)) return prev;
        return `${prev} ${trimmed}`;
      });
    }
    // Same accumulation pattern for conversation-phase answers — the
    // patient can speak across multiple breaths and fix mistranscriptions
    // in the textarea before tapping Send.
    if (p === "conversation") {
      setConversationDraft((prev) => {
        const trimmed = text.trim();
        if (!trimmed) return prev;
        if (!prev) return trimmed;
        if (prev.endsWith(trimmed)) return prev;
        return `${prev} ${trimmed}`;
      });
    }

    // Conversation phase used to auto-stop the mic on every final and
    // fire J.A.C.K.I.E. immediately. That bypassed the patient's
    // ability to fix STT mistranscriptions before her reasoning ran.
    // Now we keep the mic open and let the patient tap Send (or
    // continue speaking) — same pattern as the complaint phase.
    // The Send tap fires a `conversation_answer` event server-side
    // (see advancePhase below) which is the canonical commit signal.
    if (p === "conversation") {
      // Just exit the final-handler — no mic stop, no auto-trigger.
      return;
    }

    // ───────────── final → immediate commit for identity phases ─────────────
    // Flux v2 emits is_final=True at end of turn (silence ≥ eot_timeout
    // or confidence ≥ eot_threshold). When that happens for an identity
    // phase, we don't need to wait for the frontend silence timer too —
    // the canonical "patient finished" signal already fired. Without
    // this short-circuit the silence timer was racing finals: it fires
    // at 1200ms with only the partial in hand, parseDOB choked on the
    // incomplete partial, and the patient saw an empty editable card
    // even though the kiosk had captured the date correctly. We give
    // is_final priority and let the silence timer be a backstop only.
    if ((p === "first_name" || p === "last_name" || p === "dob") && !confirmRef.current) {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      const commitFn = handleStopMicRef.current;
      if (commitFn) {
        // Tiny defer so the state updates above flush before parse runs.
        setTimeout(() => commitFn(), 30);
      }
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

  const { state: micState, start, stop } = useAudioCapture({ onFrame, onNoiseLevel });

  const [ttsState, setTtsState] = useState("idle");

  const playTTS = useCallback((text, onEnded) => {
    if (!text || !voice) {
      if (typeof onEnded === "function") setTimeout(onEnded, 100);
      return;
    }
    // Hard-cancel anything already playing AND any fetch still in
    // flight from a previous playTTS call. The abort path is critical
    // for fast phase transitions (sex tap → "Got it." → next prompt
    // all within ~2s): without it, slow fetches resolve out-of-order
    // and assign their audio object to audioRef AFTER the next prompt
    // already started, breaking the ended-event chain that auto-starts
    // the mic. AbortController turns out-of-order resolution into a
    // clean "AbortError" that we silently ignore.
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (ttsAbortRef.current) {
      try { ttsAbortRef.current.abort(); } catch { /* noop */ }
    }
    // Hard-cancel any in-flight Web Speech utterance too. Without this,
    // if a prior TTS fell back to Web Speech (server temporarily 5xx'd or
    // returned fallback JSON), the queued utterance keeps playing while
    // a fresh ElevenLabs stream starts — the patient hears two voices at
    // the same time, often in different timbres (browser default vs the
    // selected persona). Live calibration on 2026-05-07 surfaced this.
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch { /* noop */ }
    }
    const ac = new AbortController();
    ttsAbortRef.current = ac;
    const url = `${HTTP_BASE}/api/tts?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}`;

    // Try fetching — if server returns fallback JSON, use Web Speech API.
    fetch(url, { signal: ac.signal }).then(async (res) => {
      if (ac.signal.aborted) return;
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json") || res.headers.get("X-TTS-Fallback")) {
        // ElevenLabs unavailable — fall back to browser Web Speech API.
        speakWithWebSpeechAPI(text, onEnded);
        return;
      }
      // Normal audio stream — play as before.
      const blob = await res.blob();
      if (ac.signal.aborted) return;
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
    }).catch((err) => {
      // AbortError from .abort() — not a failure, just superseded.
      if (err && err.name === "AbortError") return;
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
    // Defense-in-depth against the voice double-play bug: cancel ANY
    // queued or in-progress Web Speech utterance before queuing the new
    // one. Without this, two consecutive fallbacks (ElevenLabs flaky →
    // both fall back) result in both utterances playing concurrently.
    try { window.speechSynthesis.cancel(); } catch { /* noop */ }
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
    // Gender is button-driven: play the prompt but don't auto-start the mic.
    // The patient taps a button; voice input would only confuse Deepgram.
    if (phase === "gender") {
      playTTS(prompt);
      return;
    }
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
    // Branch on whether the nurse pre-filled identity. With prefill we
    // route through the verify step so the patient can confirm with one
    // tap; the persona has already been chosen so the verify screen can
    // greet them by name. Without prefill it's the normal voice flow
    // starting from first_name.
    if (prefill) {
      setStep("verify");
    } else {
      setStep("interview");
      setPhaseIdx(0);
      // first_name + last_name are captured separately, then combined
      // into `name` once last_name is confirmed (or skipped). Downstream
      // consumers see only the combined `name` field.
      setAnswers({ first_name: "", last_name: "", name: "", dob: "", gender: "", complaint: "" });
    }
    lastNameAttemptsRef.current = 0;
    phaseTextRef.current = "";
    lastFinalRef.current = "";
    setInterimText("");
    setComplaintDraft("");  // fresh editable textarea for new interview
    setConversationDraft("");
    setConversationLog([]);
    setConfirm(null);
    setParseError("");
    // Reset the cross-view store at the start of a new interview.
    clearIdentity();
  };

  // Patient confirmed the nurse-entered identity is correct. Bake the
  // prefilled values into answers, push them to the dashboard via
  // identity_update, and jump straight to the sex-at-birth tap (skipping
  // first_name / last_name / dob phases). PHASES = [first_name,
  // last_name, dob, gender, ...] so phaseIdx 3 = gender.
  const confirmPrefill = useCallback(() => {
    if (!prefill) return;
    const first = (prefill.first_name || "").trim();
    const last = (prefill.last_name || "").trim();
    const fullName = [first, last].filter(Boolean).join(" ");
    setAnswers({
      first_name: first,
      last_name: last,
      name: fullName,
      dob: prefill.dob || "",
      gender: "",
      complaint: "",
    });
    if (send) {
      if (fullName) send({ type: "identity_update", data: { name: fullName } });
      if (prefill.dob) send({ type: "identity_update", data: { dob: prefill.dob } });
    }
    setStoreIdentity({ name: fullName, dob: prefill.dob || "" });
    setPhaseIdx(3); // gender (first_name=0, last_name=1, dob=2, gender=3)
    setStep("interview");
  }, [prefill, send]);

  // Patient rejected the prefill ("No, that's not me / let me speak").
  // Clear the override and fall back to the normal voice flow.
  const rejectPrefill = useCallback(() => {
    setPrefill(null);
    setAnswers({ first_name: "", last_name: "", name: "", dob: "", gender: "", complaint: "" });
    setPhaseIdx(0);
    setStep("interview");
  }, []);

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
          // Parse failure used to retry-loop with a TTS prompt asking
          // the patient to repeat themselves — patients hated this
          // (the "eternal loop"). New behaviour: drop the raw transcript
          // straight into the editable confirm card so the patient
          // sees what was heard and can fix it inline (or tap Try
          // again to re-record). The card's input is the source of
          // truth; whatever they Send commits.
          setParseError("");
          // Best-effort cleanup: title-case the raw text so it looks
          // like a name even before edits.
          value = titleCase(captured);
          setConfirm({ phase, value });
          phaseTextRef.current = "";
          lastFinalRef.current = "";
          setInterimText("");
          return;
        }
        value = r.value;
      }
      setParseError("");
      setConfirm({ phase, value });
      // No more TTS readback — the editable card is the confirmation.
      // Keeping audio handoff lightweight so the patient can act fast.
    } else if (phase === "dob") {
      const r = parseDOB(captured);
      if (!r.ok) {
        // Parse fail → fall into the editable card with an empty date
        // input but include `heard` so the card can show "I heard:
        // 'April 1990'" — patients need to know what was captured,
        // otherwise it feels like the kiosk dropped their input.
        setParseError("");
        setConfirm({ phase: "dob", value: "", heard: captured });
        phaseTextRef.current = "";
        lastFinalRef.current = "";
        setInterimText("");
        return;
      }
      setParseError("");
      // All branches now flow into the editable card. No TTS readback —
      // the visible date is the confirmation. `partial: true` (e.g.
      // year + month, no day) is also passed through so the card can
      // hint that the day was guessed.
      setConfirm({ phase: "dob", value: r.value, partial: !!r.partial, heard: r.partial ? captured : null });
    } else {
      // complaint — keep the text as-is, no confirmation required.
      // Sex-at-birth is button-only (no mic), so this branch is never
      // hit for "gender".
      setAnswers((a) => ({ ...a, complaint: captured }));
    }
  }, [phase, phaseIdx, voice, stop, interimText, playTTS, scheduleMicRestart, send]);

  const onConfirmYes = useCallback((overrideValue) => {
    if (!confirm) return;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    // The editable card calls this with the (possibly hand-corrected)
    // value from its input; voice "yes" calls with no arg, in which
    // case we fall back to the originally-parsed confirm.value.
    // last_name allows the empty string explicitly (= skip), so we
    // accept any string type — only undefined/null falls through.
    const finalValue = (overrideValue !== undefined && overrideValue !== null)
      ? overrideValue
      : confirm.value;
    // Identity propagation: downstream consumers (clinician dashboard,
    // sessionLog, EvidenceReport) see ONE combined `name` field. We only
    // emit `name` after last_name confirms (or last_name is skipped) so
    // the dashboard never shows a half-captured "Janelle" then "Janelle
    // Tamayo" update.
    setAnswers((a) => {
      const next = { ...a, [confirm.phase]: finalValue };
      if (confirm.phase === "last_name") {
        next.name = `${a.first_name || ""} ${finalValue}`.trim();
      }
      return next;
    });
    if (confirm.phase === "last_name") {
      // Combine and emit the full name now. If last_name was skipped
      // (value === ""), we still emit just the first name as the `name`.
      const fullName = `${(answers.first_name || "")} ${finalValue}`.trim();
      setStoreIdentity({ name: fullName });
      const identityData = { name: fullName };
      send && send({ type: "identity_update", data: identityData });
    } else if (confirm.phase === "dob") {
      setStoreIdentity({ dob: finalValue });
      const identityData = { dob: finalValue };
      if (isMinorFromDOB(finalValue)) identityData.is_minor = true;
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
    // Persona confirms verbally only on first_name (warm welcome by
    // name) and the last_name skip path (otherwise the patient sees a
    // silent jump to DOB after a blank surname). For last_name (with
    // a value) and DOB, the next phase's prompt IS the acknowledgement
    // — back-to-back "Got it. Got it. Got it." felt repetitive in
    // testing, and the next question landing within ~1s gives the
    // patient enough signal that their input was accepted. The 1500ms
    // backup timeout guarantees advance even if the TTS audio fails
    // to fire its "ended" event (race conditions with overlapping
    // fetches — see selectGender for the same pattern).
    let ackText = "";
    if (confirm.phase === "first_name" && finalValue) {
      ackText = `Got it, ${finalValue}.`;
    } else if (confirm.phase === "last_name" && !finalValue) {
      ackText = "Okay — skipping that.";
    }
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      advanced = true;
      if (phaseIdx < PHASES.length - 1) setPhaseIdx((i) => i + 1);
      else setStep("done");
    };
    if (ackText) {
      playTTS(ackText, advance);
      setTimeout(advance, 1800);
    } else {
      // Silent advance — give the next phase's TTS a 150ms beat to
      // start so the screen transition doesn't feel jolting.
      setTimeout(advance, 150);
    }
  }, [confirm, phaseIdx, send, answers, playTTS]);

  // Try-again button on the editable confirm card: just clear state
  // and restart the mic. No spelling-mode escalation (the patient can
  // fix mistranscriptions by typing in the editable input — that's
  // strictly better UX than letter-by-letter speech), no retry TTS
  // prompt (the prior phase TTS still rings in the patient's ear and
  // a second prompt feels like nagging). For last_name we still tick
  // the attempt counter so the 2-strike skip path remains armed if
  // the patient hits Try again repeatedly without typing.
  const onConfirmRetry = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    const rejectedPhase = confirm?.phase;
    setConfirm(null);
    setParseError("");
    setInterimText("");
    phaseTextRef.current = "";
    lastFinalRef.current = "";
    setSpellingMode(false);
    setAnswers((a) => ({ ...a, [phase]: "" }));
    if (rejectedPhase === "last_name") {
      lastNameAttemptsRef.current += 1;
    }
    scheduleMicRestart();
  }, [phase, confirm, scheduleMicRestart]);

  // Gender selection — button-driven, no parse/confirm flow. Saves the
  // value, pushes identity_update to the bus (so dashboard + EMR + report
  // see it), plays a brief verbal acknowledgement, then advances the
  // phase. Pre-empts any in-flight TTS so the patient doesn't hear the
  // prompt finish after they've already tapped. The "Got it." beat is
  // important — without it, the screen jumps to the next prompt with no
  // confirmation that the tap registered, which feels like a bug.
  const selectGender = useCallback((value) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setTtsState("idle");
    }
    setAnswers((a) => ({ ...a, gender: value }));
    setStoreIdentity({ gender: value });
    send && send({ type: "identity_update", data: { gender: value } });
    // Guard against double-advance if both the TTS callback and the
    // belt-and-suspenders timeout fire — only one should bump phaseIdx.
    // The timeout is load-bearing: when a long phase prompt is still
    // mid-fetch when the patient taps, the in-flight fetch can race
    // with the "Got it." audio and the prompt's audio object can stomp
    // audioRef.current. The "ended" event for "Got it." may not fire
    // in that case, leaving advance unwired. The 1500ms timer is a
    // hard upper bound — "Got it." is a ~500ms clip so the timer
    // either rubber-stamps a normal advance or rescues a stalled one.
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      advanced = true;
      if (phaseIdx < PHASES.length - 1) setPhaseIdx((i) => i + 1);
    };
    playTTS("Got it.", advance);
    setTimeout(advance, 1500);
  }, [phaseIdx, send, playTTS]);

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
    // Sex-at-birth is button-only — no text-fallback path needed.
  }, [phase, voice, playTTS]);

  // Bind handler refs AFTER their useCallbacks are declared, so the
  // memoized onEvent closure can call them via ref without TDZ issues.
  useEffect(() => { handleStopMicRef.current = handleStopMic; }, [handleStopMic]);
  useEffect(() => { onConfirmYesRef.current = onConfirmYes; }, [onConfirmYes]);
  useEffect(() => { onConfirmRetryRef.current = onConfirmRetry; }, [onConfirmRetry]);

  const advancePhase = useCallback(() => {
    stop();
    // For complaint phase: the source of truth is the editable textarea
    // (complaintDraft), not phaseTextRef. The patient may have edited it
    // since the last final fired, so we commit whatever's in the
    // textarea right now — what they see is what they send.
    if (phase === "complaint") {
      const text = complaintDraft.trim();
      if (text) {
        setAnswers((a) => ({ ...a, complaint: text }));
        setStoreIdentity({ complaint: text });
        send && send({ type: "identity_update", data: { complaint: text } });
      }
    } else if (phase === "conversation") {
      // Conversation phase: same editable-textarea pattern. Commit the
      // (possibly hand-corrected) draft to the backend via a dedicated
      // `conversation_answer` event — this is the canonical signal
      // that fires the next J.A.C.K.I.E. turn server-side. The textarea
      // is the source of truth; nothing else gets sent. We do NOT
      // bump phaseIdx — the conversation phase loops in place until
      // J.A.C.K.I.E. signals triage_complete. The textarea is cleared
      // when the next jackie_turn event arrives.
      const text = conversationDraft.trim();
      if (text) {
        send && send({
          type: "conversation_answer",
          data: { text, language: "en" },
        });
        // Push the just-sent answer into the on-screen log so the
        // patient sees their reply land alongside JACKIE's question.
        // Same 20-entry cap as the JACKIE-side push above.
        setConversationLog((prev) => {
          const next = [...prev, { role: "patient", text }];
          return next.length > 20 ? next.slice(-20) : next;
        });
        setProcessingState("thinking"); // optimistic — agent_activity confirms
      }
      setInterimText("");
      phaseTextRef.current = "";
      return;
    } else {
      const captured = (phaseTextRef.current || interimText || "").trim();
      if (captured) {
        setAnswers((a) => ({ ...a, [phase]: captured }));
      }
    }
    setInterimText("");
    phaseTextRef.current = "";
    if (phaseIdx < PHASES.length - 1) setPhaseIdx((i) => i + 1);
    else setStep("done");
  }, [phase, phaseIdx, stop, interimText, send, complaintDraft, conversationDraft]);

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
    setComplaintDraft("");  // wipe the editable textarea on Restart
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
        {step === "welcome" && (
          <Welcome
            onBegin={() => setStep("select")}
            onNurseEntry={() => setStep("nurse")}
          />
        )}
        {step === "nurse" && (
          <NurseEntry
            initial={prefill}
            onSave={(data) => {
              setPrefill(data);
              // If the persona has already been chosen — i.e. nurse
              // popped this open mid-interview as an override — skip the
              // persona pick and go straight to verify so the flow feels
              // like a single uninterrupted handoff. Otherwise it's the
              // normal welcome → nurse → select → verify path.
              setStep(voice ? "verify" : "select");
            }}
            onCancel={() => {
              // Mid-interview cancel: drop the in-progress prefill but
              // keep voice/answers so the patient resumes where they
              // were. Cold-start cancel: reset everything to welcome.
              if (voice) {
                setPrefill(null);
                setStep("interview");
              } else {
                setPrefill(null);
                setStep("welcome");
              }
            }}
          />
        )}
        {step === "select" && <VoiceSelector onSelect={beginInterview} />}
        {step === "verify" && (
          <VerifyIdentity
            personaName={personaName}
            prefill={prefill}
            onConfirm={confirmPrefill}
            onReject={rejectPrefill}
          />
        )}
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
            complaintDraft={complaintDraft}
            onComplaintDraftChange={setComplaintDraft}
            conversationDraft={conversationDraft}
            onConversationDraftChange={setConversationDraft}
            conversationLog={conversationLog}
            onStart={start}
            onStopMic={handleStopMic}
            onCancel={stop}
            onAdvance={advancePhase}
            onRestart={restartComplaint}
            onConfirmYes={onConfirmYes}
            onConfirmRetry={onConfirmRetry}
            onTextSubmit={handleTextSubmit}
            onSelectGender={selectGender}
            // Mid-interview escape hatch: nurse can pop the manual-entry
            // form open from within the identity phases and short-circuit
            // the voice flow. Stop the mic + any in-flight TTS first so
            // we don't keep capturing audio while the form is open and
            // so the patient doesn't hear the prompt finish in the
            // background.
            onNurseOverride={() => {
              stop();
              if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
                setTtsState("idle");
              }
              setStep("nurse");
            }}
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
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 32px", zIndex: 50,
      background: "rgba(12, 19, 36, 0.6)",
      backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
      boxShadow: "0 20px 50px rgba(47, 217, 244, 0.08)",
    }}>
      {/* Spacer keeps the title centered while the AMD pill sits right. */}
      <span style={{ width: 220 }} />
      <span style={{
        fontFamily: "'Space Grotesk', 'Inter', sans-serif",
        fontSize: 24, fontWeight: 700, letterSpacing: "-0.04em",
        color: "var(--vic-primary)",
      }}>
        V.I.C.T.O.R. ER Triage
      </span>
      <div style={{ width: 220, display: "flex", justifyContent: "flex-end" }}>
        <AMDStatusPill />
      </div>
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
        <Stat label="TLS encrypted · session-only · no audio stored" />
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

function Welcome({ onBegin, onNurseEntry }) {
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
      {/* Secondary affordance for the triage nurse: if they already have
          the patient's name and DOB (EMR pull, ambulance handoff,
          returning patient), they can pre-fill those fields here and
          the patient just confirms with a single tap. Visually de-
          emphasised so it doesn't compete with the patient-facing
          primary CTA. */}
      {onNurseEntry && (
        <div style={{ marginTop: 24 }}>
          <button
            onClick={onNurseEntry}
            style={{
              background: "transparent", border: "none",
              color: "var(--vic-on-surface-variant)",
              fontSize: 13, letterSpacing: "0.04em",
              cursor: "pointer",
              textDecoration: "underline",
              textUnderlineOffset: 4,
              fontFamily: "'JetBrains Mono', monospace",
              opacity: 0.7,
            }}
          >
            Nurse: I already have their info →
          </button>
        </div>
      )}
    </div>
  );
}

// Nurse-only fast-path entry. Triage nurse types name + DOB ahead of
// handing the kiosk to the patient. On save, we route the patient
// through the verify step (one-tap confirm) instead of the full voice
// capture, which removes the biggest source of friction in the kiosk
// flow (mishears, spelling fallback, DOB parsing).
function NurseEntry({ initial, onSave, onCancel }) {
  const [first, setFirst] = useState(initial?.first_name || "");
  const [last, setLast] = useState(initial?.last_name || "");
  // DOB stored as YYYY-MM-DD via <input type="date"> for unambiguous
  // entry. Downstream answers.dob expects free-form text the parser
  // can normalise; ISO is the cleanest format to send.
  const [dob, setDob] = useState(initial?.dob || "");
  const canSave = first.trim() && last.trim() && dob;
  const inputStyle = {
    width: "100%", padding: "14px 16px",
    background: "rgba(12, 19, 36, 0.55)",
    border: "1px solid rgba(47, 217, 244, 0.25)",
    borderRadius: 12,
    color: "var(--vic-on-surface)",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSize: 16, outline: "none", boxSizing: "border-box",
  };
  const labelStyle = {
    display: "block",
    fontSize: 11, fontWeight: 700, textTransform: "uppercase",
    letterSpacing: "0.18em", color: "rgba(47, 217, 244, 0.7)",
    marginBottom: 6,
    fontFamily: "'JetBrains Mono', monospace",
  };
  return (
    <div style={{ maxWidth: 480, width: "100%" }}>
      <h2 style={{
        fontFamily: "'Space Grotesk', 'Inter', sans-serif",
        fontSize: 28, fontWeight: 700, letterSpacing: "-0.01em",
        color: "var(--vic-on-surface)", marginBottom: 8, textAlign: "center",
      }}>
        Nurse-assisted entry
      </h2>
      <p style={{
        color: "var(--vic-on-surface-variant)", fontSize: 14, lineHeight: 1.5,
        marginBottom: 28, textAlign: "center", fontWeight: 300,
      }}>
        Type the patient's identity. They'll just confirm with a tap and
        skip straight to the clinical questions.
      </p>
      <form
        onSubmit={(e) => { e.preventDefault(); if (canSave) onSave({ first_name: first.trim(), last_name: last.trim(), dob }); }}
        style={{ display: "flex", flexDirection: "column", gap: 18 }}
      >
        <div>
          <label style={labelStyle} htmlFor="nurse-first">First name</label>
          <input id="nurse-first" autoFocus value={first} onChange={(e) => setFirst(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle} htmlFor="nurse-last">Last name</label>
          <input id="nurse-last" value={last} onChange={(e) => setLast(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle} htmlFor="nurse-dob">Date of birth</label>
          <input id="nurse-dob" type="date" value={dob} onChange={(e) => setDob(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              flex: 1, padding: "14px 0", borderRadius: 999,
              background: "transparent",
              color: "var(--vic-on-surface-variant)",
              border: "1px solid rgba(47, 217, 244, 0.25)",
              fontSize: 14, fontWeight: 600, cursor: "pointer",
              letterSpacing: "0.04em",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave}
            style={{
              flex: 2, padding: "14px 0", borderRadius: 999,
              background: canSave
                ? "linear-gradient(to right, var(--vic-primary), #008ea1)"
                : "rgba(47, 217, 244, 0.12)",
              color: canSave ? "var(--vic-on-primary)" : "var(--vic-on-surface-variant)",
              border: "none", fontSize: 15, fontWeight: 700,
              cursor: canSave ? "pointer" : "not-allowed",
              letterSpacing: "0.02em",
              boxShadow: canSave ? "0 8px 30px rgba(47, 217, 244, 0.3)" : "none",
            }}
          >
            Hand to patient →
          </button>
        </div>
      </form>
    </div>
  );
}

// Verify screen — shown only when nurse pre-filled identity. Patient
// taps once to confirm "yes that's me" and skips name/DOB voice
// capture entirely. If they tap "No", we fall back to the normal voice
// flow starting from first_name. DOB is rendered as a friendly
// month-day-year line, not raw ISO, so it's readable for a stressed
// patient.
function VerifyIdentity({ personaName, prefill, onConfirm, onReject }) {
  const fullName = [prefill?.first_name, prefill?.last_name].filter(Boolean).join(" ");
  const dobDisplay = prefill?.dob ? formatDOBHuman(prefill.dob) : "";
  return (
    <div style={{ maxWidth: 560, width: "100%", textAlign: "center" }}>
      <p style={{
        color: "var(--vic-on-surface-variant)", fontSize: 14, lineHeight: 1.5,
        marginBottom: 16, fontWeight: 300, letterSpacing: "0.04em",
        fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase",
      }}>
        {personaName} · checking your details
      </p>
      <h1 style={{
        fontFamily: "'Space Grotesk', 'Inter', sans-serif",
        fontSize: 36, fontWeight: 700, letterSpacing: "-0.01em",
        color: "var(--vic-on-surface)", marginBottom: 28, lineHeight: 1.25,
      }}>
        Hi — I have you down as…
      </h1>
      <div style={{
        padding: "28px 32px", borderRadius: 24,
        background: "linear-gradient(135deg, rgba(47, 217, 244, 0.08), rgba(0, 142, 161, 0.04))",
        border: "1px solid rgba(47, 217, 244, 0.25)",
        marginBottom: 28,
        display: "flex", flexDirection: "column", gap: 8,
      }}>
        <div style={{
          fontSize: 28, fontWeight: 700, color: "var(--vic-on-surface)",
          fontFamily: "'Space Grotesk', 'Inter', sans-serif",
        }}>
          {fullName || "(name missing)"}
        </div>
        {dobDisplay && (
          <div style={{
            fontSize: 16, color: "var(--vic-on-surface-variant)",
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.04em",
          }}>
            born {dobDisplay}
          </div>
        )}
      </div>
      <p style={{
        color: "var(--vic-on-surface-variant)", fontSize: 17,
        marginBottom: 24, fontWeight: 400,
      }}>
        Is that right?
      </p>
      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        <button
          onClick={onReject}
          style={{
            padding: "14px 28px", borderRadius: 999,
            background: "transparent",
            color: "var(--vic-on-surface-variant)",
            border: "1px solid rgba(47, 217, 244, 0.25)",
            fontSize: 14, fontWeight: 600, cursor: "pointer",
            letterSpacing: "0.04em",
          }}
        >
          No, let me say it
        </button>
        <button
          onClick={onConfirm}
          style={{
            padding: "16px 40px", borderRadius: 999,
            background: "linear-gradient(to right, var(--vic-primary), #008ea1)",
            color: "var(--vic-on-primary)", fontWeight: 700, fontSize: 16,
            border: "none", cursor: "pointer", letterSpacing: "0.02em",
            boxShadow: "0 8px 30px rgba(47, 217, 244, 0.3)",
          }}
        >
          Yes, that's me →
        </button>
      </div>
    </div>
  );
}

// Render YYYY-MM-DD as a readable "Apr 13, 1990" so a stressed patient
// can verify at a glance. Falls back to the raw value if parsing fails.
function formatDOBHuman(iso) {
  if (!iso || typeof iso !== "string") return iso || "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mi = parseInt(m[2], 10) - 1;
  if (mi < 0 || mi > 11) return iso;
  return `${months[mi]} ${parseInt(m[3], 10)}, ${m[1]}`;
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
  complaintDraft, onComplaintDraftChange,
  conversationDraft, onConversationDraftChange,
  conversationLog,
  onStart, onStopMic, onCancel, onAdvance, onConfirmYes, onConfirmRetry,
  onTextSubmit, onRestart, onSelectGender,
  onNurseOverride,
}) {
  const recording = micState === "recording";
  const error = micState === "error";
  const speaking = ttsState === "speaking";
  const thinking = processingState === "thinking";
  const gotIt = processingState === "got_it";
  const { label: defaultLabel, title: defaultTitle } = phasePrompt(phase);
  const isConvo = phase === "conversation";
  // Conversation is "Step 6 of 6" — surface the underlying step on the
  // left so patients reading "Question 2/5" don't misread it as "Step 2".
  // ESI / Beth-Israel-style triage doesn't number follow-up questions on
  // the patient's chrome, but our kiosk has a step counter, so make the
  // relationship explicit: "Step 6 of 6 · Q2/5".
  const label = isConvo
    ? jackieTurn
      ? `Step 6 of 6 · Q${jackieTurn.turn}/${jackieTurn.max_turns}`
      : "Step 6 of 6"
    : defaultLabel;
  // When the editable confirm card is showing, the question title
  // ("And your date of birth?") is redundant with the card's own
  // "Here's what I heard" heading and adds noise. Swap to a brief
  // "Just confirm" header so the patient's eyes go to the input, not
  // back to the question.
  const isConfirming = !!confirm;
  const confirmTitleByPhase = {
    first_name: "Confirm your first name",
    last_name: "Confirm your last name",
    dob: "Confirm your date of birth",
  };
  const title = isConvo && jackieTurn?.text
    ? jackieTurn.text
    : (isConfirming && confirmTitleByPhase[phase])
      ? confirmTitleByPhase[phase]
      : defaultTitle;
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
  const hasCaptured = !!captured.trim();

  let subline;
  if (isConfirming) subline = "Tap Send if it's right — or fix it first.";
  else if (gotIt) subline = "Got it — one second.";
  // While thinking/speaking the bottom StatusPill is the canonical
  // indicator — duplicating it in this subline reads as two redundant
  // "Victor is thinking" messages stacked on screen. Suppress here.
  else if (thinking) subline = "";
  else if (speaking) subline = "";
  else if (recording && spellingMode) subline = "Spell your first name out — one letter at a time.";
  else if (recording) subline = "Go ahead — I'm listening.";
  else if (parseError) subline = parseError;
  else if (isConvo && jackieTurn?.closing) subline = "All done — a clinician will be with you soon.";
  else if (isConvo) subline = "Take your time — answer when you're ready.";
  else if (captured && phase === "complaint") subline = `Thanks for sharing. Tap "I'm done" when you've said everything, or keep talking.`;
  else if (phase === "gender") subline = "Tap whichever applies — needed for clinical accuracy.";
  else subline = "Just a moment — getting ready to listen.";

  // The nurse override is only useful at the friction-heavy identity
  // phases. Past that point the patient has already spoken their name +
  // DOB, so showing a manual-entry escape hatch would just clutter the
  // screen during clinical questions.
  const showNurseOverride =
    !!onNurseOverride &&
    (phase === "first_name" || phase === "last_name" || phase === "dob");

  return (
    <div style={{
      width: "100%", maxWidth: 960,
      display: "flex", flexDirection: "column", alignItems: "center", gap: 24,
      position: "relative",
    }}>
      {showNurseOverride && (
        <button
          onClick={onNurseOverride}
          // Top-right corner of the interview canvas, mono-styled and
          // de-emphasised so it reads as a staff-only affordance — not
          // something the patient feels they're supposed to tap. The
          // copy frames it as "for a nurse", which discourages patient
          // self-selection without locking it behind a PIN.
          style={{
            position: "absolute", top: -8, right: 0,
            background: "transparent",
            border: "1px solid rgba(47, 217, 244, 0.18)",
            borderRadius: 999,
            color: "var(--vic-on-surface-variant)",
            padding: "6px 14px",
            fontSize: 11, letterSpacing: "0.14em",
            textTransform: "uppercase",
            cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace",
            opacity: 0.6,
            transition: "opacity .15s, border-color .15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.borderColor = "rgba(47, 217, 244, 0.4)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.6"; e.currentTarget.style.borderColor = "rgba(47, 217, 244, 0.18)"; }}
          aria-label="Nurse: enter patient identity manually"
        >
          Nurse · enter manually →
        </button>
      )}
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
          // Scale font down for long JACKIE turns — a 40px title on
          // a 200-char question makes the screen feel cramped and the
          // first words wrap awkwardly. Tiered based on length:
          //   <= 60 chars  → 40px (normal phase prompts)
          //   61-120 chars → 30px
          //   > 120 chars  → 24px (long conversational follow-ups)
          fontSize: title && title.length > 120
            ? 24
            : title && title.length > 60
            ? 30
            : 40,
          fontWeight: 700, letterSpacing: "-0.02em",
          color: "var(--vic-on-surface)", marginBottom: 12,
          lineHeight: 1.2,
        }}>
          {title}
        </h1>
        <p style={{
          color: "var(--vic-on-surface-variant)", fontSize: 17, fontWeight: 300,
          lineHeight: 1.55, margin: 0,
        }}>
          {subline}
        </p>
        {/* "Persona is thinking…" pill used to live here. Removed —
            the bottom StatusPill already shows the same state and was
            duplicating the indicator on the conversation phase. The
            subline ("Victor is putting a thought together.") still
            communicates the wait verbally so we don't lose any UX. */}
      </div>

      {!isConfirming && phase !== "gender" && (
        <MicCircle recording={recording} error={error} onClick={recording ? onStopMic : onStart} />
      )}

      {phase === "gender" && !isConfirming && (
        <GenderPicker onSelect={onSelectGender} />
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
      ) : phase === "gender" ? null : phase === "complaint" ? (
        // Editable textarea — accumulates each finalised utterance and
        // shows the running interim partial below it. Patient can fix
        // mistranscriptions before tapping Send. What you see is what
        // gets sent to the clinician.
        <ComplaintEditor
          value={complaintDraft}
          onChange={onComplaintDraftChange}
          interim={interimText}
          recording={recording}
          speaking={speaking}
        />
      ) : phase === "conversation" ? (
        // Same editable-textarea pattern as the complaint phase, but
        // with a scrollable on-screen conversation log above the box
        // so the patient sees the running dialogue (their answers +
        // JACKIE's questions). Box resets on every new jackie_turn
        // so the input is always fresh; the log persists.
        <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%" }}>
          <ConversationHistory log={conversationLog} personaName={personaName} currentTurn={jackieTurn} />
          <ComplaintEditor
            value={conversationDraft}
            onChange={onConversationDraftChange}
            interim={interimText}
            recording={recording}
            speaking={speaking}
          />
        </div>
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
          complaintHasText={!!complaintDraft && complaintDraft.trim().length > 0}
          conversationHasText={!!conversationDraft && conversationDraft.trim().length > 0}
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
  complaintHasText, conversationHasText,
  onCommit, onCancel, onAdvance, onRestart,
}) {
  const thinking = processingState === "thinking";
  const speaking = ttsState === "speaking";

  // ── COMPLAINT + CONVERSATION PHASES ─────────────────────────────────
  // Both share the editable-textarea pattern: source of truth is the
  // textarea, Send commits its contents, the screen shows "Send" only
  // when the box has text. Conversation phase doesn't have a Restart
  // affordance — the patient corrects in-place rather than re-recording
  // a whole answer. Both share the disabled-while-busy display so the
  // patient sees the persona's status during model latency.
  if (phase === "complaint" || phase === "conversation") {
    // While thinking/speaking, the bottom StatusPill is the canonical
    // "Victor is thinking…" indicator. Showing the same text on a
    // disabled button here stacks two of them on screen. Suppress —
    // the patient still gets the StatusPill + persona orb animation.
    if (thinking || speaking) return null;
    const hasText = phase === "complaint" ? complaintHasText : conversationHasText;
    if (hasText) {
      return (
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          {phase === "complaint" && (
            <button onClick={onRestart} style={secondaryBtnStyle}>
              ↺ Restart
            </button>
          )}
          <button onClick={onAdvance} style={primaryBtnStyle(true)}>
            Send →
          </button>
        </div>
      );
    }
    // No text yet — just hint that the mic will fill it in.
    return null;
  }

  // ── IDENTITY PHASES (first_name, last_name, dob) ────────────────────
  // Same de-dup as above — StatusPill carries the "thinking/speaking"
  // copy, no need to repeat it on a disabled button.
  if (thinking || speaking) return null;

  if (recording && hasCaptured) {
    return (
      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        <button onClick={onCommit} style={primaryBtnStyle(true)}>
          I'm done →
        </button>
      </div>
    );
  }

  if (recording) {
    return (
      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        <button onClick={onCancel} style={secondaryBtnStyle}>
          Cancel
        </button>
      </div>
    );
  }

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
    { key: "gender", label: "Sex at birth" },
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

// Button picker for the sex-at-birth phase. Tap-only: voice ("are
// you male or female?") has too many failure modes and is more
// invasive than a button tap. Order: Female first because the demo's
// pitch is centered on under-triage of women in CVD.
//
// Field semantics: this captures *sex assigned at birth* (FHIR
// AdministrativeGender / Joint Commission birth-sex), which is what
// the ED triage agents need for differential priors, drug dosing,
// lab reference ranges, and imaging protocol decisions. Gender
// identity is a separate field and out of scope for the demo.
//
// Strictly binary: every patient has a sex assigned at birth, so
// "prefer not to say" doesn't fit a question with a guaranteed answer
// — and the LLM agents need a value to risk-stratify. Intersex
// (~1.7% of births) almost never changes immediate ED management and
// is captured separately in real EHRs after triage. Big Venus / Mars
// icons make this read at a glance for distressed or visually-
// impaired patients.
function GenderPicker({ onSelect }) {
  const opts = [
    { value: "Female", Icon: Venus },
    { value: "Male",   Icon: Mars  },
  ];
  // Shared card style for the two icon options.
  const cardStyle = {
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", gap: 14,
    padding: "28px 20px", borderRadius: 24,
    background: "linear-gradient(135deg, rgba(47, 217, 244, 0.08), rgba(0, 142, 161, 0.04))",
    border: "1px solid rgba(47, 217, 244, 0.25)",
    color: "var(--vic-on-surface)",
    fontWeight: 700, fontSize: 16, letterSpacing: "0.02em",
    cursor: "pointer",
    minHeight: 160,
    boxShadow: "0 8px 30px rgba(47, 217, 244, 0.08)",
    transition: "transform .12s, border-color .12s, background .12s",
  };
  const cardHoverIn = (e) => {
    e.currentTarget.style.borderColor = "rgba(47, 217, 244, 0.5)";
    e.currentTarget.style.background = "linear-gradient(135deg, rgba(47, 217, 244, 0.14), rgba(0, 142, 161, 0.08))";
  };
  const cardHoverOut = (e) => {
    e.currentTarget.style.transform = "scale(1)";
    e.currentTarget.style.borderColor = "rgba(47, 217, 244, 0.25)";
    e.currentTarget.style.background = "linear-gradient(135deg, rgba(47, 217, 244, 0.08), rgba(0, 142, 161, 0.04))";
  };
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 16,
      maxWidth: 480, width: "100%",
      padding: "0 24px",
    }}>
      {/* 1×2 row of the two options (Female first per CVD-bias pitch). */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, 1fr)",
        gap: 16,
      }}>
        {opts.map(({ value, Icon }) => (
          <button
            key={value}
            onClick={() => onSelect(value)}
            style={cardStyle}
            onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.97)")}
            onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
            onMouseLeave={cardHoverOut}
            onMouseEnter={cardHoverIn}
          >
            <Icon size={56} strokeWidth={1.5} color="var(--vic-primary)" />
            <span>{value}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MicErrorHelp({ onRetry, onTextSubmit, phase }) {
  const [textInput, setTextInput] = useState("");
  const [showSteps, setShowSteps] = useState(false);
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
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
        <button
          onClick={() => setShowSteps((s) => !s)}
          style={{
            padding: "8px 14px", borderRadius: 999,
            background: "transparent", color: "var(--vic-on-error-bg)",
            border: "1px solid rgba(255, 180, 171, 0.35)", cursor: "pointer",
            fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600,
          }}
        >
          {showSteps ? "▾ hide steps" : "▸ how to enable"}
        </button>
      </div>
      {showSteps && (
        <div style={{
          padding: "12px 14px", borderRadius: 10,
          background: "rgba(12, 19, 36, 0.55)",
          border: "1px solid rgba(255, 180, 171, 0.18)",
          fontSize: 12, lineHeight: 1.55,
          color: "var(--vic-on-surface)",
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          <BrowserSteps
            label="Chrome / Edge"
            steps={[
              "Click the camera/mic icon in the address bar (right of the URL).",
              "Choose Allow / Always allow on this site.",
              "Refresh the page, then tap Try mic again.",
            ]}
          />
          <BrowserSteps
            label="Safari"
            steps={[
              "Safari menu → Settings → Websites → Microphone.",
              "Set this site to Allow.",
              "Refresh the page, then tap Try mic again.",
            ]}
          />
          <BrowserSteps
            label="Firefox"
            steps={[
              "Click the lock icon in the address bar.",
              "Open Connection secure → More information → Permissions.",
              "Set Use the Microphone to Allow, then refresh + Try mic again.",
            ]}
          />
          <div style={{
            fontSize: 11, color: "var(--vic-on-surface-variant)",
            fontStyle: "italic", marginTop: 2,
          }}>
            If you previously denied permission, the browser may have remembered the choice — these steps reset it.
          </div>
        </div>
      )}
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

// One block of browser-specific microphone-permission instructions inside
// the MicErrorHelp recovery card. Doesn't auto-detect the browser — shows
// all three so the patient can find the one matching what they're using
// (auto-detection would silently mislead users on edge browsers like
// Brave / Vivaldi / DuckDuckGo).
function BrowserSteps({ label, steps }) {
  return (
    <div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10, fontWeight: 700, letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--vic-on-error-bg)", opacity: 0.85,
        marginBottom: 4,
      }}>
        {label}
      </div>
      <ol style={{
        margin: 0, paddingLeft: 18, lineHeight: 1.55,
        color: "var(--vic-on-surface-variant)",
      }}>
        {steps.map((step, i) => (
          <li key={i} style={{ marginBottom: 2 }}>{step}</li>
        ))}
      </ol>
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

// Editable accumulating transcript for the complaint phase. The textarea
// is bound to a controlled state (complaintDraft) that the parent grows
// on each finalised utterance via the onEvent handler. Patient can edit
// the text directly to fix STT mistranscriptions before tapping Send.
// While the mic is hot, the latest interim partial appears below the
// textarea as a soft preview — landed text appears in the textarea
// proper once Deepgram finalises that segment.
// Scrollable on-screen log of the JACKIE↔patient dialogue during the
// conversation phase. Helps stressed/distracted patients see what was
// just asked (and what they already answered) without trying to recall
// from voice. Each entry is a chat-style bubble: persona Qs left-aligned
// in cyan, patient As right-aligned in neutral. Auto-scrolls to bottom
// on new entries; capped at the last ~6 entries on screen by max-height
// (older entries scroll up but stay accessible). Hides when empty so
// the patient doesn't see a confusing blank box on the very first turn
// (the title carries the active question).
function ConversationHistory({ log, personaName, currentTurn }) {
  const scrollRef = useRef(null);
  // Drop the most recent JACKIE question from the log if it's the
  // CURRENT turn — the title already shows it word-for-word, no need
  // to duplicate. We still keep the patient's prior answer to it
  // (if any) and all earlier turns.
  const renderLog = (() => {
    if (!log || log.length === 0) return [];
    const last = log[log.length - 1];
    if (
      currentTurn?.text
      && last?.role === "jackie"
      && last.text === currentTurn.text
    ) {
      return log.slice(0, -1);
    }
    return log;
  })();
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [renderLog.length]);
  if (renderLog.length === 0) return null;
  return (
    <div
      ref={scrollRef}
      className="vic-glass"
      style={{
        width: "100%", maxHeight: 220, overflowY: "auto",
        padding: "14px 16px", borderRadius: 16,
        border: "1px solid rgba(47, 217, 244, 0.15)",
        display: "flex", flexDirection: "column", gap: 10,
      }}
    >
      <div style={{
        fontSize: 9, fontWeight: 700,
        color: "rgba(47, 217, 244, 0.55)",
        textTransform: "uppercase", letterSpacing: "0.2em",
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        Conversation so far
      </div>
      {renderLog.map((entry, i) => {
        const isJackie = entry.role === "jackie";
        return (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: isJackie ? "flex-start" : "flex-end",
            }}
          >
            <div style={{
              maxWidth: "82%",
              padding: "8px 12px",
              borderRadius: 12,
              fontSize: 13, lineHeight: 1.45,
              background: isJackie
                ? "rgba(47, 217, 244, 0.10)"
                : "rgba(255, 255, 255, 0.06)",
              border: isJackie
                ? "1px solid rgba(47, 217, 244, 0.22)"
                : "1px solid rgba(255, 255, 255, 0.08)",
              color: "var(--vic-on-surface)",
            }}>
              <div style={{
                fontSize: 9, letterSpacing: "0.14em",
                textTransform: "uppercase", marginBottom: 3,
                color: isJackie
                  ? "rgba(47, 217, 244, 0.7)"
                  : "var(--vic-on-surface-variant)",
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {isJackie ? personaName : "you"}
              </div>
              {entry.text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ComplaintEditor({ value, onChange, interim, recording, speaking }) {
  // Merge live interim into what the patient sees in the textarea so they
  // can confirm "yes, the system heard me" without scanning a separate
  // status line. The committed `value` (final transcripts) is the source of
  // truth; interim is appended as a soft visual addendum until the next
  // EndOfTurn promotes it. If the patient edits the textarea, their typed
  // text becomes the new `value` and interim is dropped from the display
  // until a fresh utterance arrives.
  const interimTrim = (interim || "").trim();
  const interimAlreadyInValue =
    interimTrim &&
    value.toLowerCase().trim().endsWith(interimTrim.toLowerCase());
  const displayValue =
    interimTrim && !interimAlreadyInValue
      ? value
        ? `${value} ${interimTrim}`
        : interimTrim
      : value;
  const handleChange = (e) => {
    // Strip trailing interim before passing the edit upstream so the next
    // partial doesn't compound on top of itself. If the user kept the
    // interim suffix verbatim, treat it as accepted and bake it into value.
    onChange(e.target.value);
  };
  return (
    <div className="vic-glass" style={{
      width: "100%", padding: 24, borderRadius: 24,
      border: "1px solid rgba(47, 217, 244, 0.2)",
      boxShadow: "0 32px 64px -12px rgba(0, 0, 0, 0.5)",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "baseline",
      }}>
        <span style={{
          fontSize: 11, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.2em", color: "rgba(47, 217, 244, 0.7)",
        }}>
          Your concern · editable
        </span>
        <span style={{
          fontSize: 10, color: "var(--vic-on-surface-variant)",
          fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.06em",
        }}>
          {recording ? "● mic on — keep talking, or fix any words below" : speaking ? "speaking…" : "tap mic when ready"}
        </span>
      </div>
      <textarea
        value={displayValue}
        onChange={handleChange}
        placeholder="When you start speaking, what you say will appear here. You can edit any of it before you send."
        spellCheck
        style={{
          width: "100%",
          minHeight: 140,
          padding: "14px 16px",
          background: "rgba(12, 19, 36, 0.55)",
          border: "1px solid rgba(47, 217, 244, 0.18)",
          borderRadius: 12,
          color: "var(--vic-on-surface)",
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: 17,
          lineHeight: 1.5,
          resize: "vertical",
          outline: "none",
          boxSizing: "border-box",
        }}
      />
      {/* The "HEARING <interim>" preview block lived here in the previous
          design. It's now redundant — interim is merged directly into
          the textarea displayValue (see top of this component) so the
          patient sees their words land in the box itself, not in a
          parallel status line. */}
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

// Editable confirm card — modelled on Claude voice / Gemini / ChatGPT
// voice patterns. After the mic stops, the captured text is rendered in
// an editable input the patient can correct inline, with a single
// primary Send → button that commits whatever's currently in the box.
// The displayed text IS the confirmation: no "yes / no" voice round-
// trip, no spelling-mode loop unless the patient explicitly asks for
// it. Voice "yes" / "no" handlers in the parent still work for
// touch-free accessibility — voice "yes" submits the unedited value,
// voice "no" calls onRetry.
function ConfirmCard({ confirm, onYes, onRetry }) {
  const isFirstName = confirm.phase === "first_name";
  const isLastName = confirm.phase === "last_name";
  const isDOB = confirm.phase === "dob";
  const fieldLabel = isFirstName
    ? "First name"
    : isLastName
    ? "Last name"
    : "Date of birth";
  const heading = isFirstName
    ? "Here's what I heard. Edit if needed."
    : isLastName
    ? confirm.value
      ? "Here's what I heard. Edit if needed."
      : "I couldn't catch your last name — type it or skip."
    : isDOB
    ? confirm.value
      ? confirm.partial
        ? "I caught part of it — pick or type the right date."
        : "Here's what I heard. Edit if needed."
      : "I didn't catch a full date — pick or type it."
    : "Here's what I heard. Edit if needed.";
  const heardHint = isDOB && confirm.heard ? confirm.heard : null;
  // Local state for the editable value. Reset whenever a new confirm
  // event arrives (different phase, or new attempt at the same phase).
  // For DOB we coerce non-ISO strings to "" so the native <input
  // type="date"> never gets a value it can't parse — otherwise the
  // browser logs a warning and ignores the value, which (a) is noisy
  // and (b) silently drops the patient's data on the floor.
  const initialEdited = (() => {
    const v = confirm?.value || "";
    if (confirm?.phase === "dob" && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return "";
    }
    return v;
  })();
  const [edited, setEdited] = useState(initialEdited);
  const inputRef = useRef(null);
  useEffect(() => {
    const v = confirm?.value || "";
    if (confirm?.phase === "dob" && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      setEdited("");
    } else {
      setEdited(v);
    }
    // Move caret to end so the patient can keep typing without
    // selecting first. Tiny delay lets the input mount.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        try { el.setSelectionRange(len, len); } catch { /* date inputs */ }
      }
    });
  }, [confirm?.value, confirm?.phase]);
  const trimmed = edited.trim();
  const canSend = !!trimmed || isLastName; // last_name allows empty (skip)
  const submit = () => {
    if (!canSend) return;
    onYes(trimmed);
  };
  const handleKey = (e) => {
    // Enter submits, Escape clears for re-record. Standard keyboard
    // ergonomics for power users / clinicians at the kiosk.
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); onRetry(); }
  };
  return (
    <div className="vic-glass" style={{
      width: "100%", padding: 32, borderRadius: 32,
      border: "1px solid rgba(47, 217, 244, 0.3)",
      boxShadow: "0 32px 64px -12px rgba(0, 0, 0, 0.5)",
      display: "flex", flexDirection: "column", gap: 16, alignItems: "stretch",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "baseline",
      }}>
        <span style={{
          fontSize: 11, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.2em", color: "rgba(47, 217, 244, 0.8)",
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {fieldLabel} · editable
        </span>
        <span style={{
          fontSize: 10, color: "var(--vic-on-surface-variant)",
          fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.06em",
        }}>
          tap to fix · enter to send
        </span>
      </div>
      <div style={{
        fontSize: 14, color: "var(--vic-on-surface-variant)", textAlign: "center",
      }}>
        {heading}
      </div>
      {isDOB ? (
        // Native date input gives the patient a proper picker for
        // edits. confirm.value is already normalised to YYYY-MM-DD by
        // parseDOB so it loads cleanly into <input type="date">.
        <>
          <input
            ref={inputRef}
            type="date"
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
            onKeyDown={handleKey}
            style={{
              width: "100%", padding: "18px 20px",
              background: "rgba(12, 19, 36, 0.55)",
              border: "1px solid rgba(47, 217, 244, 0.25)",
              borderRadius: 16,
              color: "var(--vic-on-surface)",
              fontFamily: "'Space Grotesk', 'Inter', sans-serif",
              fontSize: 28, fontWeight: 600, letterSpacing: "-0.01em",
              textAlign: "center", outline: "none", boxSizing: "border-box",
            }}
          />
          {heardHint && (
            // Patient said something we couldn't fully parse (e.g.
            // "April 1990" — month + year but no day). Showing the
            // raw transcript here proves the kiosk was listening; the
            // date input above is where they finalise it.
            <div style={{
              fontSize: 13, color: "var(--vic-on-surface-variant)",
              fontStyle: "italic", textAlign: "center",
              padding: "0 4px", opacity: 0.75,
            }}>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
                color: "rgba(47, 217, 244, 0.55)", letterSpacing: "0.18em",
                marginRight: 8, textTransform: "uppercase",
              }}>i heard</span>
              "{heardHint}"
            </div>
          )}
        </>
      ) : (
        <input
          ref={inputRef}
          type="text"
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
          onKeyDown={handleKey}
          autoCapitalize="words"
          autoComplete="off"
          spellCheck={false}
          placeholder={isLastName ? "Type your last name (or leave blank to skip)" : "Type to fix"}
          style={{
            width: "100%", padding: "18px 20px",
            background: "rgba(12, 19, 36, 0.55)",
            border: "1px solid rgba(47, 217, 244, 0.25)",
            borderRadius: 16,
            color: "var(--vic-on-surface)",
            fontFamily: "'Space Grotesk', 'Inter', sans-serif",
            fontSize: 32, fontWeight: 700, letterSpacing: "-0.01em",
            textAlign: "center", outline: "none", boxSizing: "border-box",
          }}
        />
      )}
      <div style={{
        display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center",
        marginTop: 4,
      }}>
        <button
          onClick={onRetry}
          aria-label="Re-record"
          style={{
            padding: "14px 24px", borderRadius: 999,
            background: "transparent",
            color: "var(--vic-on-surface-variant)", fontWeight: 600, fontSize: 14,
            border: "1px solid rgba(47, 217, 244, 0.25)", cursor: "pointer",
            letterSpacing: "0.04em",
          }}
        >
          🎤 Try again
        </button>
        <button
          onClick={submit}
          disabled={!canSend}
          style={{
            padding: "14px 36px", borderRadius: 999,
            background: canSend
              ? "linear-gradient(to right, var(--vic-primary), #008ea1)"
              : "rgba(47, 217, 244, 0.12)",
            color: canSend ? "var(--vic-on-primary)" : "var(--vic-on-surface-variant)",
            fontWeight: 700, fontSize: 15,
            border: "none",
            cursor: canSend ? "pointer" : "not-allowed",
            boxShadow: canSend ? "0 8px 30px rgba(47, 217, 244, 0.3)" : "none",
            letterSpacing: "0.02em",
          }}
        >
          {isLastName && !trimmed ? "Skip →" : "Send →"}
        </button>
      </div>
    </div>
  );
}

// Strip disfluencies + repeats from a raw STT transcript so the patient's
// "Reason for visit" reads cleanly on the thank-you screen while we wait
// for SCRIBE's distilled chief_complaint_short. Conservative: only kills
// fillers ("um", "uh", "like", "you know") and trims whitespace — does
// not paraphrase, so clinical detail stays intact.
function tidyComplaint(raw) {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/\b(?:uh+|um+|er+|ah+|hm+|mm+)\b[,.\s]*/gi, "");
  s = s.replace(/\b(?:you know|i mean|like,|sort of|kind of)\b[,.\s]*/gi, "");
  s = s.replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
  s = s.replace(/^[,.\s]+/, "").replace(/[,\s]+$/, "");
  if (s) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

function Done({ room, answers = {} }) {
  // Prefer SCRIBE's distilled chief_complaint_short ("Chest pain x 24h")
  // over the verbatim. If SCRIBE hasn't responded yet, fall back to a
  // locally-tidied version of the patient's raw transcript so the umms
  // and ers don't show up on the chart-style summary.
  const identity = useIdentity();
  const distilled = identity?.chief_complaint_short || "";
  const reason = distilled || tidyComplaint(answers.complaint);
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

      {(answers.name || answers.dob || reason) && (
        <div className="vic-glass" style={{
          textAlign: "left", padding: 24, borderRadius: 24,
          border: "1px solid rgba(69, 70, 77, 0.15)",
          marginBottom: 24,
        }}>
          {answers.name && <SummaryRow label="Name" value={answers.name} />}
          {answers.dob && <SummaryRow label="Date of birth" value={answers.dob} />}
          {reason && <SummaryRow label="Reason for visit" value={reason} />}
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
