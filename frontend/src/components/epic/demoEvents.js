export const DEMO_EVENTS = [
  // Kiosk intake completes first — clinician dashboard shows captured identity
  // before voice triage starts. In a real session this fires when J.A.C.K.I.E.
  // confirms name + DOB + reason for visit during intake.
  { delay: 100, type: "identity_update", data: {
    name: "Hernandez, Maria L.",
    dob: "1971-03-14",
    complaint: "Stomach pain, nausea",
  } },
  { delay: 200, type: "agent_activity", data: { agent: "V.I.C.T.O.R.", status: "active", action: "Listening for first utterance" } },
  { delay: 600, type: "transcript", data: { text: "my stomach hurts and i feel nauseous", language: "en", is_final: true } },
  { delay: 800, type: "agent_activity", data: { agent: "S.C.R.I.B.E.", status: "active", action: "Composing subjective" } },
  { delay: 1100, type: "biomarker", data: { helios: { mentalStrain: 0.68, stress: 0.66, distress: 0.66, exhaustion: 0.33, sleepPropensity: 0.33, lowSelfEsteem: 0.0 } } },
  { delay: 1300, type: "agent_activity", data: { agent: "M.E.R.C.E.D.", status: "active", action: "Evaluating concordance" } },
  { delay: 1700, type: "concordance_flag", data: {
    tier: 1, trigger_phrase: "stomach hurts",
    biomarker_signal: "stress: 0.66, distress: 0.66, mental strain: 0.68",
    gloss: "Patient presents with abdominal pain (standard acuity 2.8) but voice biomarkers indicate elevated cardiovascular stress. In MIMIC-IV data, this presentation in female CVD patients was under-triaged. Recommend reassessment.",
    agent: "M.E.R.C.E.D."
  } },
  { delay: 2200, type: "soap_update", data: {
    subjective: "Patient reports stomach pain with associated nausea. Onset and duration not yet established.",
    objective: "Thymia Helios — stress 0.66, distress 0.66, mental strain 0.68, exhaustion 0.33.",
    assessment: "Tier 1 concordance flag: atypical CVD presentation. Abdominal pain in MIMIC-IV female CVD cohort averaged acuity 2.80 vs 2.15 for chest pain.",
    plan: [
      "Bedside 12-lead ECG",
      "Stat troponin",
      "Telemetry monitoring",
      "Cardiology consult if elevated",
    ],
    agent: "S.C.R.I.B.E."
  } },
  { delay: 2400, type: "esi_update", data: {
    standard_esi: 3, victor_esi: 2,
    adjustment_reason: "Tier 1 concordance flag — atypical CVD presentation with elevated voice biomarkers"
  } },
  { delay: 2800, type: "agent_activity", data: { agent: "V.I.C.T.O.R.", status: "active", action: "Escalation routed · ESI 2" } },
  // J.A.C.K.I.E.'s escalated-mode follow-up (after the concordance flag).
  // In a live session this fires after V.I.C.T.O.R. flips state.escalated = true.
  { delay: 3000, type: "jackie_turn", data: {
    text: "I just want to make sure I have the full picture. Have you had any pressure or tightness in your chest, jaw, or arm — even briefly?",
    turn: 1, max_turns: 6, language: "en",
  } },
];

export const DEMO_PATIENT = {
  name: "Hernandez, Maria L.",
  sex: "Female",
  age: 54,
  dob: "03/14/1971",
  mrn: "E1404907",
  csn: "15309",
  room: "ED 12 / B",
  arrived: "3:42 PM (19 min ago)",
  cc: "Stomach pain, nausea",
  hw: "5'4\" / 168 lb",
};
