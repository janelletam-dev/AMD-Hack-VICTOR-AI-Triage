"""Clinical knowledge service — single source of truth for the clinical
data scattered across V.I.C.T.O.R., M.E.R.C.E.D., S.C.R.I.B.E., and
J.A.C.K.I.E. Pure Python, no LLM, deterministic.

This module owns:
  - Bates' 7 dimensions of a symptom (HPI framework)
  - OPQRST/SAMPLE element definitions (used by coverage_tracker)
  - Pertinent-negative clinical concepts (NegEx vocabulary)
  - Red-flag libraries per chief complaint
  - Priority orderings per chief complaint (coverage tracker uses these)
  - Validated risk scores (HEART score for chest pain — pre-bedside,
    H+A+R only since EKG and troponin come later in the workup)

Agents IMPORT from here. Don't duplicate clinical knowledge in agent
prompts — when the cardiac red flags need updating, this is the one
file you change.

══════════════════════════════════════════════════════════════════════
PRIMARY REFERENCES (North America + United Kingdom, current as of
the 2025-2026 demo timeframe). Where US and UK guidance diverge we
note both — the kiosk runs in either jurisdiction.
══════════════════════════════════════════════════════════════════════

GENERAL ED PRACTICE
  - Tintinalli's Emergency Medicine: A Comprehensive Study Guide,
    9th ed. (2020, McGraw-Hill). Standard US reference.
  - Rosen's Emergency Medicine: Concepts and Clinical Practice,
    10th ed. (2022, Elsevier). Standard US reference.
  - Oxford Handbook of Emergency Medicine, 5th ed. (2020). Standard
    UK reference.
  - Bates' Guide to Physical Examination, 13th ed. (Bickley &
    Szilagyi, 2021) — source of the 7 HPI dimensions.

TRIAGE FRAMEWORKS
  - ESI v4 (Emergency Severity Index) — Agency for Healthcare
    Research and Quality (AHRQ), 2020. US standard.
  - CTAS (Canadian Triage and Acuity Scale) — Canadian Association of
    Emergency Physicians (CAEP), 2016 revision; CTAS 2024 update in
    progress. Canadian standard.
  - Manchester Triage System (MTS) v3 — Royal College of Emergency
    Medicine (RCEM), Manchester Triage Group 2014. UK / European
    standard.

CHEST PAIN / ACS
  - 2021 AHA/ACC/ASE/CHEST/SAEM/SCCT/SCMR Guideline for the
    Evaluation and Diagnosis of Chest Pain (Gulati M et al,
    Circulation 2021;144:e368-e454). The current US standard for
    ED chest pain workup.
  - 2023 ESC Guidelines for the Management of Acute Coronary
    Syndromes (Byrne RA et al, Eur Heart J 2023;44:3720-3826).
  - NICE NG185: Acute coronary syndromes (2020, last reviewed 2023).
    Current UK standard.
  - HEART score: Six AJ et al, Neth Heart J 2008;16(6):191-6
    (original derivation). Backus BE et al, Int J Cardiol
    2013;168(3):2153-8 (multicentre validation). Mahler SA et al,
    Circ Cardiovasc Qual Outcomes 2015;8(2):195-203 (HEART Pathway
    accelerated diagnostic protocol). HEART score is endorsed by
    AHA/ACC 2021 chest pain guideline as a validated decision aid.
  - T-MACS (Troponin-only Manchester Acute Coronary Syndromes) —
    Body R et al, Emerg Med J 2017;34:349-356. UK alternative,
    requires high-sensitivity troponin.

PULMONARY EMBOLISM
  - 2019 ESC Guidelines for Acute PE (Konstantinides SV et al,
    Eur Heart J 2020;41:543-603).
  - 2020 ASH Guidelines for Management of VTE (Stevens SM et al,
    Blood Adv 2020;4:4693-4738). US-relevant.
  - NICE NG158: Venous thromboembolic diseases (2020, last reviewed
    2023). UK standard.
  - Wells score (Wells PS et al, Ann Intern Med 2001;135:98-107).
  - PERC rule (Kline JA et al, J Thromb Haemost 2008;6:772-80).
  - YEARS algorithm (van der Hulle T et al, Lancet 2017;390:289-97)
    — increasingly preferred over modified Wells in academic centres.

STROKE
  - 2019 AHA/ASA Guidelines for the Early Management of Patients
    with Acute Ischemic Stroke (Powers WJ et al, Stroke
    2019;50:e344-e418), with 2024 focused update on endovascular
    therapy (Stroke 2024).
  - NICE NG128: Stroke and transient ischaemic attack in over 16s
    (2019, last reviewed 2023). UK standard.
  - NIHSS (Brott T et al, Stroke 1989;20:864-870; current modern
    version in Lyden 2017 review).
  - FAST / BE-FAST screen — AHA/ASA public-facing tool (2017
    expansion to BE-FAST adds Balance + Eye changes).

ABDOMINAL PAIN
  - ACR Appropriateness Criteria: Right Lower Quadrant Pain
    (American College of Radiology, 2023 update). Imaging guidance.
  - NICE NG143: Suspected acute appendicitis (in development; CG170
    Faecal calprotectin remains current adjunct, 2023).
  - Alvarado Score (Alvarado A, Ann Emerg Med 1986;15:557-564) —
    classic but limited specificity in modern cohorts.
  - AAS / Adult Appendicitis Score (Sammalkorpi HE et al, BMC
    Gastroenterol 2014;14:114) — outperforms Alvarado in adults.
  - AIR (Appendicitis Inflammatory Response) score (Andersson M &
    Andersson RE, World J Surg 2008;32:1843-9).

HEADACHE
  - AHS Consensus Statement on Acute Migraine (American Headache
    Society 2021, update in progress 2024).
  - NICE NG216: Headaches in over 12s — diagnosis and management
    (2021, last reviewed 2023). UK standard.
  - Ottawa SAH Rule (Perry JJ et al, JAMA 2013;310:1248-1255;
    validated in Perry 2017 multicentre trial).
  - ACEP Clinical Policy: Critical Issues in the Evaluation and
    Management of Adult Patients Presenting to the ED with Acute
    Headache (2019).

SHORTNESS OF BREATH
  - 2022 AHA/ACC/HFSA Heart Failure Guideline (Heidenreich PA et al,
    Circulation 2022;145:e895-e1032).
  - 2023 ESC Heart Failure Guidelines focused update (McDonagh TA
    et al, Eur Heart J 2023).
  - NICE NG106: Chronic heart failure (2018, last reviewed 2023);
    NG191: COVID-19 rapid guideline (covers acute SOB workup).

TRAUMA
  - ATLS 10th Edition (American College of Surgeons, 2018).
  - NICE NG39: Major trauma — assessment and initial management
    (2016, last reviewed 2023).
  - Canadian C-Spine Rule (Stiell IG et al, JAMA 2001;286:1841-8).
  - NEXUS criteria (Hoffman JR et al, NEJM 2000;343:94-99).

SEPSIS
  - Surviving Sepsis Campaign 2021 International Guidelines (Evans L
    et al, Crit Care Med 2021;49:e1063-e1143; Intensive Care Med
    2021;47:1181-1247). Joint US/Europe.
  - NICE NG51: Sepsis — recognition, diagnosis and early management
    (2016, last reviewed 2024).
  - NEWS2 (National Early Warning Score 2) — Royal College of
    Physicians, 2017. UK NHS standard.
  - qSOFA (Singer M et al, JAMA 2016;315:801-810). Sepsis-3
    definitions still current.

NLP / METHODS
  - NegEx algorithm: Chapman WW et al, J Biomed Inform
    2001;34:301-310 (basis for our pertinent-negatives detection).

══════════════════════════════════════════════════════════════════════

When in doubt about clinical accuracy, defer to the relevant guideline
above and update this module — not the agent prompts. The whole point
of consolidating clinical knowledge here is so updates flow from one
file into every agent that imports it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


# ── Bates' 7 dimensions of a symptom ──────────────────────────────────
# Reference framework that every HPI should cover. The keys are the
# canonical names; values are plain-English clinician-style prompts.
# Source: Bickley LS & Szilagyi PG, "Bates' Guide to Physical
# Examination and History Taking", 13th ed (2021), Ch.1. Same framework
# taught in US (LCME), UK (GMC Tomorrow's Doctors), and Canadian
# (CanMEDS) medical curricula.
HPI_DIMENSIONS: dict[str, str] = {
    "location":   "Where exactly is it? Does it move anywhere?",
    "quality":    "What does it feel like — sharp, dull, pressure, burning?",
    "quantity":   "How severe is it on a 1-10 scale?",
    "timing":     "When did it start? Constant or intermittent?",
    "setting":    "What were you doing when it started?",
    "modifying":  "What makes it better or worse? What have you tried?",
    "associated": "Any other symptoms along with it?",
}


# ── OPQRST / SAMPLE coverage elements ────────────────────────────────
# Element name → list of regex patterns that mark it as covered when
# matched in patient utterances. Used by coverage_tracker.extract_covered.
# Patterns are deliberately broad — false positives (skipping a topic
# the patient only grazed) cost less than false negatives (asking
# again).
#
# OPQRST and SAMPLE are taught in every paramedic / EMT / nursing
# curriculum on both sides of the Atlantic — see National Registry of
# EMTs (US) and Joint Royal Colleges Ambulance Liaison Committee
# (JRCALC, UK) syllabuses. Tintinalli's 9th ed Ch.2 is the canonical
# ED-textbook reference.
ELEMENTS: dict[str, list[str]] = {
    "onset": [
        r"\b\d+\s*(min|minute|hour|hr|day|week|month|year)s?\s+ago\b",
        # "an hour ago" / "a few days ago" / "one minute ago" — patient
        # answers with English number words instead of digits. Without
        # this, JACKIE re-asked onset (observed scenario 2 verbatim
        # 2026-05-08: patient said "an hour ago" in Q1, JACKIE re-asked
        # in Q2 because the digits-only pattern missed the answer).
        r"\b(?:an?|one|two|three|four|five|six|seven|eight|nine|ten|"
        r"a\s+few|a\s+couple\s+(?:of\s+)?|several)\s+"
        r"(min|minute|hour|hr|day|week|month|year)s?\s+ago\b",
        r"\b(yesterday|today|tonight|this\s+morning|last\s+night|last\s+week|last\s+month)\b",
        r"\b(since|started|began|onset|came\s+on)\b",
        r"\b(suddenly|gradually|all\s+of\s+a\s+sudden)\b",
    ],
    "severity": [
        r"\b\d{1,2}\s*(out\s+of|/)\s*10\b",
        r"\b(ten\s+out\s+of\s+ten|worst\s+pain|worst\s+(it'?s?\s+)?ever)\b",
        r"\b(mild|moderate|severe|excruciating|unbearable)\b",
        r"\b(pretty\s+bad|really\s+bad|very\s+bad|not\s+(too\s+)?bad)\b",
        r"\b(?:probably|maybe|like|about|around|say|sometimes)\s+(?:an?\s+)?(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b",
        r"\b(?:it'?s|that'?s)\s+(?:a\s+)?(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b",
        r"\b(hurts?\s+a\s+lot|really\s+hurts?|quite\s+painful|manageable|bearable|tolerable)\b",
        # Bare-numeric answer to a 1-10 question. Matches ONLY when the
        # entire patient utterance is a stand-alone number (or "it's a
        # nine") — the ^...$ anchors with optional surrounding whitespace
        # keep this conservative. Without this pattern, a one-word answer
        # like "nine." doesn't mark severity as covered, and JACKIE
        # re-asks "on a scale of 1 to 10..." (observed bug from
        # scenario 1 verbatim, 2026-05-08).
        r"^\s*(?:it'?s\s+(?:a\s+)?)?(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)[\s.!?]*$",
    ],
    "quality": [
        r"\b(sharp|dull|burning|stabbing|crushing|pressure|tight(ness)?|"
        r"throbbing|aching|cramp\w*|squeez\w*|pounding|stinging|gnawing)\b",
        r"\b(feels?\s+like)\b",
    ],
    "region": [
        r"\b(chest|abdomen|abdominal|stomach|belly|head|back|arm|leg|throat|"
        r"neck|jaw|shoulder|hip|knee|ankle|wrist|hand|foot|"
        r"left\s+(side|arm|leg)|right\s+(side|arm|leg)|center|middle|"
        r"upper|lower|epigastric|flank|groin|pelvic)\b",
    ],
    "radiation": [
        r"\b(radiat\w*|spreads?|moves?|going\s+(down|into|up)|"
        r"down\s+my\s+\w+|into\s+my\s+\w+|up\s+to\s+my\s+\w+|"
        r"shoots?\s+(down|into|up))\b",
    ],
    "associated": [
        r"\b(nausea|nauseous|vomit\w*|throw(ing)?\s+up|fever|chills|"
        r"short(ness)?\s+of\s+breath|sob|dizz\w*|lightheaded|"
        r"sweat\w*|diaphoretic|fatigue|cough\w*|swelling|swollen|"
        r"weakness|numb\w*|tingl\w*|blurred\s+vision|"
        r"palpitations|racing\s+heart|diarr?h[eo]?a|constipat\w*|"
        r"urin\w+\s+(?:problems?|issues?|changes?)|"
        r"loose\s+stools?|blood\s+in\s+(?:stool|urine))\b",
    ],
    "aggravating": [
        r"\b(worse\s+(when|with|after)|aggravat\w*|trigger\w*|"
        r"brought\s+on\s+by|happens?\s+when|gets?\s+worse)\b",
    ],
    "alleviating": [
        r"\b(better\s+(when|with|after)|relieved\s+by|helps?\s+when|"
        r"goes?\s+away\s+when|eases?\s+(when|with))\b",
    ],
    "setting": [
        # Bates' 5th dimension — what the patient was doing when symptoms
        # started. Often diagnostic (exertional CP → ACS; postprandial
        # abd pain → biliary; sudden onset at rest → SAH or PE).
        r"\b(was|were)\s+(sitting|walking|running|exercising|climbing|"
        r"working|driving|sleeping|eating|lying|standing)\b",
        r"\b(at\s+rest|during\s+exercise|after\s+(eating|a\s+meal|lunch|dinner|breakfast)|"
        r"when\s+(I|i)\s+\w+ed)\b",
        r"\b(i'?ve\s+been|i\s+was\s+just|while)\s+(eating|sitting|walking|running|"
        r"exercising|working|driving|sleeping|lying\s+down|standing|"
        r"cooking|resting|relaxing)\b",
    ],
    "allergies": [
        r"\b(no\s+allerg\w*|allerg\w+\s+to|i'?m\s+allergic|"
        r"penicillin|sulfa|peanut|latex|nkda)\b",
    ],
    "medications": [
        r"\b(no\s+(med|medication)|not\s+(taking|on)\s+any\s+(med|medication)|"
        r"taking|on\s+\w+\s+(for|to)|metformin|lisinopril|aspirin|"
        r"insulin|blood\s+thinner|anticoagulant|warfarin|eliquis|"
        r"plavix|statin|ibuprofen|tylenol|acetaminophen)\b",
    ],
    "pmh": [
        r"\b(diabet\w*|hypertens\w*|high\s+blood\s+pressure|"
        r"heart\s+(disease|attack|condition|failure)|asthma|"
        r"copd|stroke|cancer|kidney\s+disease|liver\s+disease|"
        r"history\s+of|i\s+have\s+\w+|previously\s+had|"
        r"diagnosed\s+with|"
        r"had\s+this\s+before|never\s+had\s+this|first\s+time|"
        r"happens?\s+(all\s+the\s+time|often|frequently|regularly)|"
        r"this\s+has\s+happened\s+before)\b",
    ],
    "lmp": [
        r"\b(last\s+period|lmp|last\s+menstrual|menstrual\s+period|"
        r"pregnan\w*|could\s+be\s+pregnant|missed\s+period)\b",
    ],
}


# ── Pertinent-negative clinical concepts (NegEx vocabulary) ──────────
# Each entry: (canonical_label_for_chart, regex_pattern_for_concept).
# coverage_tracker.extract_negatives looks for these AFTER a negation
# trigger inside a 6-word window.
#
# Reference: Chapman WW, Bridewell W, Hanbury P, Cooper GF, Buchanan
# BG. "A simple algorithm for identifying negated findings and
# diseases in discharge summaries." J Biomed Inform. 2001;34(5):
# 301-310. NegEx remains the most widely-cited baseline for clinical
# negation detection; modern transformer-based approaches (e.g.
# BioBERT-NegEx, Khandelwal 2020) outperform it but with much higher
# compute cost. For triage-rate keyword detection this is plenty.
NEGATIVE_CONCEPTS: list[tuple[str, str]] = [
    ("radiation",       r"radiat\w*"),
    ("SOB",             r"(?:short(?:ness)?\s+of\s+breath|sob|trouble\s+breathing)"),
    ("diaphoresis",     r"(?:sweat\w*|diaphor\w*)"),
    ("nausea",          r"nause\w*"),
    ("vomiting",        r"(?:vomit\w*|throw(?:ing)?\s+up)"),
    ("fever",           r"fever\w*"),
    ("chills",          r"chills?"),
    ("dizziness",       r"(?:dizz\w*|lightheaded)"),
    ("syncope",         r"(?:syncope|fainted?|passed\s+out|black(?:ed)?\s+out)"),
    ("palpitations",    r"palpitations?"),
    ("chest pain",      r"chest\s+pain"),
    ("cough",           r"cough\w*"),
    ("hemoptysis",      r"(?:blood\s+(?:in\s+)?(?:cough|sputum)|coughing\s+up\s+blood)"),
    ("hematemesis",     r"blood\s+in\s+(?:vomit|throw(?:ing)?\s+up)"),
    ("blood in stool",  r"blood\s+in\s+(?:my\s+)?(?:stool|poop)"),
    ("trauma",          r"(?:trauma|fall|fell|hit|injur\w*)"),
    ("LOC",             r"(?:loss\s+of\s+consciousness|loc|black(?:ed)?\s+out)"),
    ("anticoagulants",  r"(?:blood\s+thinner|anticoagulant|warfarin|eliquis|plavix)"),
    ("diarrhea",        r"diarr?h[eo]?e?a"),
    ("constipation",    r"constipat\w*"),
    ("urinary symptoms", r"(?:urin\w+|pee(?:ing)?|burn(?:ing)?\s+when\s+(?:I\s+)?(?:pee|urinat))"),
    ("bowel changes",   r"(?:bowel\s+(?:change|movement|problem)|loose\s+stool)"),
    ("prior episodes",  r"(?:had\s+this\s+before|similar\s+(?:before|episode)|like\s+this\s+before|"
                        r"happens?\s+(?:all\s+the\s+time|often|frequently|before)|first\s+time)"),
    ("recent travel",   r"recent\s+travel"),
    ("leg swelling",    r"(?:leg\s+swelling|swollen\s+legs?|calf\s+pain)"),
    ("vision changes",  r"vision\s+(?:changes?|loss|problems?)"),
    ("neck stiffness",  r"(?:neck\s+stiff|stiff\s+neck)"),
    ("weakness",        r"weakness"),
    ("numbness",        r"(?:numb\w*|tingl\w*)"),
    ("allergies",       r"allerg\w*"),
    ("medications",     r"(?:medication|meds?)"),
    ("pregnancy",       r"pregnan\w*"),
]


# ── Priority orderings per chief complaint ──────────────────────────
# Per-CC orderings reflect what experienced ED clinicians ask first
# (the questions with the highest likelihood ratio for the relevant
# can't-miss diagnoses). Cardiac front-loads quality + radiation +
# associated symptoms (per AHA/ACC 2021); abdominal front-loads
# location + migration (ACR 2023, Tintinalli Ch.74); SOB front-loads
# onset + DVT/PE screen (NICE NG158, ESC 2019 PE).
DEFAULT_ORDER: list[str] = [
    "onset", "severity", "quality", "region", "radiation",
    "associated", "aggravating", "alleviating", "setting",
    "pmh", "medications", "allergies",
]
CARDIAC_ORDER: list[str] = [
    "onset", "quality", "radiation", "associated", "severity",
    "setting", "aggravating", "pmh", "medications", "allergies", "alleviating",
]
ABDOMINAL_ORDER: list[str] = [
    "onset", "region", "quality", "associated", "aggravating",
    "severity", "pmh", "medications", "allergies", "alleviating", "setting",
]
HEADACHE_ORDER: list[str] = [
    "onset", "severity", "quality", "associated", "aggravating",
    "pmh", "medications", "allergies", "alleviating", "setting",
]
SOB_ORDER: list[str] = [
    "onset", "associated", "severity", "aggravating", "quality",
    "setting", "pmh", "medications", "allergies", "alleviating",
]


# ── Red flags library (data version of JACKIE's prompt content) ──────
# Each chief complaint's "can't-miss" diagnoses + key triage questions.
# Sourced from current US (ACEP / AHA / ACC) and UK (RCEM / NICE)
# guidelines — see top-of-file REFERENCES block. When guidelines are
# updated, edit here and every agent that imports gets the new content.
@dataclass
class RedFlagSet:
    cant_miss: list[str]              # diagnoses to rule out at triage
    key_questions: list[str]          # high-yield triage questions
    warning_phrases: list[str]        # patient phrasings → instant escalate

RED_FLAGS: dict[str, RedFlagSet] = {
    # Chest pain — 2021 AHA/ACC/ASE/CHEST/SAEM/SCCT/SCMR Chest Pain
    # Guideline (Gulati 2021); 2023 ESC ACS Guidelines (Byrne 2023);
    # NICE NG185 (2020, reviewed 2023). The five "can't-miss"
    # categories below are the ED standard "deadly D's" for chest pain.
    "chest_pain": RedFlagSet(
        cant_miss=["ACS / MI", "PE", "Aortic dissection", "Tension pneumothorax",
                   "Cardiac tamponade", "Esophageal rupture"],
        key_questions=[
            "Pressure or tightness vs sharp / pleuritic?",
            "Radiation to jaw, arm, back, or shoulder?",
            "Associated SOB, diaphoresis, nausea?",
            "Exertional or at rest?",
            "Tearing pain radiating to back? (dissection)",
            "Recent surgery, immobility, or leg swelling? (PE)",
        ],
        warning_phrases=["pressure", "elephant on chest", "crushing",
                         "tearing", "ripping", "tight band", "won't go away"],
    ),
    # Abdominal pain — ACR Appropriateness Criteria: Right Lower
    # Quadrant Pain (2023 update). Tintinalli's 9th ed Ch.74. The
    # AAA-rupture and ectopic-pregnancy lines are the two highest
    # mortality misses in the ED literature for "abd pain".
    "abdominal_pain": RedFlagSet(
        cant_miss=["Ectopic pregnancy", "Appendicitis", "AAA rupture",
                   "Bowel ischemia", "Perforation", "Atypical ACS"],
        key_questions=[
            "Where exactly? Has it moved?",
            "When was your last menstrual period? (women of childbearing age)",
            "Vomiting blood or blood in stool?",
            "Fever or chills?",
            "Sudden severe onset? (AAA / perforation / mesenteric)",
        ],
        warning_phrases=["worst pain", "tearing in my back", "doubled over",
                         "can't keep anything down"],
    ),
    # Headache — NICE NG216 (2021, reviewed 2023); ACEP Clinical
    # Policy on Acute Headache (2019). Ottawa SAH Rule (Perry JAMA
    # 2013, validated Perry 2017) is the standard SAH-screen tool;
    # we surface its key features as triage questions here.
    "headache": RedFlagSet(
        cant_miss=["SAH", "Meningitis", "ICH", "GCA", "Carotid dissection",
                   "Sinus venous thrombosis"],
        key_questions=[
            "Sudden / thunderclap, or gradual onset?",
            "Worst headache of your life?",
            "Neck stiffness or fever?",
            "Vision changes, weakness, or numbness?",
            "Recent head injury?",
        ],
        warning_phrases=["worst headache of my life", "thunderclap",
                         "can't see clearly", "stiff neck", "couldn't move"],
    ),
    # SOB — 2019 ESC PE Guidelines (Konstantinides 2020); 2022
    # AHA/ACC/HFSA HF Guideline (Heidenreich 2022); 2023 ESC HF
    # focused update; NICE NG106 (2018, reviewed 2023). Wells score
    # for PE risk-strat lives here too once we wire it in.
    "shortness_of_breath": RedFlagSet(
        cant_miss=["PE", "Pneumothorax", "ACS", "CHF exacerbation",
                   "Anaphylaxis", "Tamponade"],
        key_questions=[
            "Sudden vs gradual?",
            "Leg swelling or calf pain? (DVT/PE)",
            "Chest pain, cough, or coughing up blood?",
            "Worse lying flat? (orthopnea → CHF)",
            "Recent surgery, immobility, OCPs?",
        ],
        warning_phrases=["can't breathe", "can't catch my breath",
                         "drowning", "suffocating"],
    ),
    # Trauma — ATLS 10th ed (American College of Surgeons, 2018);
    # NICE NG39 (2016, reviewed 2023); Canadian C-Spine Rule (Stiell
    # JAMA 2001) and NEXUS criteria (Hoffman NEJM 2000) are the
    # two validated C-spine clearance tools; we ask the questions
    # that drive both.
    "trauma": RedFlagSet(
        cant_miss=["Intracranial hemorrhage", "C-spine injury",
                   "Solid organ injury", "Pneumothorax", "Pelvic fracture"],
        key_questions=[
            "Mechanism — how did it happen?",
            "Loss of consciousness or memory loss?",
            "Blood thinners (aspirin, warfarin, Eliquis, Plavix)?",
            "Neck or back pain?",
            "Numbness, tingling, weakness anywhere?",
        ],
        warning_phrases=["blacked out", "can't move my legs", "neck hurts",
                         "I'm on warfarin"],
    ),
}


def red_flags_for(chief_complaint: str | None) -> RedFlagSet | None:
    """Return the RedFlagSet matching a chief complaint, or None."""
    if not chief_complaint:
        return None
    cc = chief_complaint.lower()
    if any(k in cc for k in ("chest", "heart", "pressure")):
        return RED_FLAGS["chest_pain"]
    if any(k in cc for k in ("abdom", "stomach", "belly", "gut")):
        return RED_FLAGS["abdominal_pain"]
    if any(k in cc for k in ("headache", "head pain", "migraine", "head ache")):
        return RED_FLAGS["headache"]
    if any(k in cc for k in ("breath", "breathing", "short of breath", "sob")):
        return RED_FLAGS["shortness_of_breath"]
    if any(k in cc for k in ("fall", "accident", "trauma", "hit", "injur")):
        return RED_FLAGS["trauma"]
    return None


# ── HEART score (clinical / pre-bedside) ─────────────────────────────
# Standard HEART: H+E+A+R+T, 0-10, three risk tiers (low / mod / high).
# At ED triage we only have H+A+R (max 6) — EKG and troponin come at
# the bedside. We surface the partial as "clinical HEART" with a clear
# note that EKG + troponin are pending. Validated to identify low-risk
# patients with sub-2% 6-week MACE in the low-risk tier.
#
# References:
#   - Six AJ, Backus BE, Kelder JC. "Chest pain in the emergency room:
#     value of the HEART score." Neth Heart J. 2008;16(6):191-196.
#     (Original derivation, n=122.)
#   - Backus BE, Six AJ, Kelder JC, et al. "A prospective validation
#     of the HEART score for chest pain patients at the emergency
#     department." Int J Cardiol. 2013;168(3):2153-2158. (Multicentre
#     validation, n=2440.)
#   - Mahler SA, Riley RF, Hiestand BC, et al. "The HEART Pathway
#     randomized trial: identifying emergency department patients
#     with acute chest pain for early discharge." Circ Cardiovasc
#     Qual Outcomes. 2015;8(2):195-203.
#   - Endorsed by 2021 AHA/ACC/ASE/CHEST/SAEM/SCCT/SCMR Chest Pain
#     Guideline (Gulati 2021) as a validated decision aid.
#   - UK alternative: T-MACS (Body R et al, EMJ 2017) — requires
#     hs-troponin so isn't used at pre-bedside triage.
#
# Components:
#   H History (0-2):
#       0 = slightly suspicious (atypical / vague)
#       1 = moderately suspicious (some classical features)
#       2 = highly suspicious (multiple classical features)
#   A Age (0-2):
#       0 = <45, 1 = 45-64, 2 = ≥65
#   R Risk factors (0-2):
#       0 = none, 1 = 1-2, 2 = ≥3 OR prior atherosclerotic dx
#   E EKG (added at bedside): 0-2
#   T Troponin (added at bedside): 0-2

HEART_RISK_FACTOR_PATTERNS: dict[str, list[str]] = {
    # The HEART risk factor list per the original score:
    # HTN, hypercholesterolemia, DM, obesity (BMI > 30), smoking,
    # family hx CAD, prior atherosclerotic disease (MI / PCI / CABG /
    # CVA / TIA / PVD).
    "htn":         [r"\b(?:high\s+blood\s+pressure|hypertens\w+|htn)\b"],
    "dm":          [r"\b(?:diabet\w+|t2dm|t1dm|sugar\s+(?:problem|disease)|on\s+insulin|metformin)\b"],
    "hld":         [r"\b(?:high\s+cholesterol|hyperlipidemia|hld|dyslipid\w+|on\s+(?:a\s+)?statin)\b"],
    "smoking":     [r"\b(?:smok\w+|cigarette|tobacco|nicotine|vape|vaping)\b"],
    "obesity":     [r"\b(?:obes\w+|overweight|bmi\s+(?:over|above|>)\s*30)\b"],
    "family_hx":   [r"\b(?:family\s+(?:hx|history)\s+(?:of\s+)?(?:heart|cardiac|mi|stroke))\b",
                    r"\b(?:my\s+)?(?:dad|father|mom|mother|brother|sister)\s+\w*\s*(?:had\s+a\s+)?(?:heart\s+attack|mi|cabg|stroke|heart\s+disease)\b"],
    # Tightened: require first-person framing so "my dad had a heart
    # attack" doesn't get classified as the patient's own prior MI
    # (that's family_hx, scored separately below). Procedure mentions
    # like "stent" are usually self-referential in a triage context
    # so we keep those liberal.
    "prior_cad":   [r"\b(?:i'?ve?\s+had|i\s+had|my)\s+(?:a\s+)?(?:heart\s+attack|mi)\b",
                    r"\b(?:prior|previous)\s+mi\b",
                    r"\bmy\s+(?:cabg|bypass|stent|pci|angioplasty)\b",
                    r"\bi\s+(?:had|have\s+had)\s+(?:a\s+)?(?:cabg|bypass|stent|pci|angioplasty)\b",
                    r"\b(?:i\s+have|i'?ve\s+got)\s+coronary\s+(?:disease|artery\s+disease)\b"],
    # Same tightening for prior CVA — "my mom had a stroke" is family_hx.
    "prior_cva":   [r"\b(?:i'?ve?\s+had|i\s+had|my)\s+(?:a\s+)?(?:stroke|cva|tia|mini[\s-]stroke)\b",
                    r"\b(?:i\s+have|i'?ve\s+got)\s+(?:cva|tia)\b"],
    "prior_pvd":   [r"\b(?:peripheral\s+(?:vascular|artery)|pad|pvd|claudication)\b"],
}


def detect_heart_risk_factors(text: str) -> list[str]:
    """Find HEART-relevant risk factors mentioned anywhere in the
    patient's transcript / chief complaint. Returns dedup list of
    canonical factor names (htn, dm, hld, smoking, obesity, family_hx,
    prior_cad, prior_cva, prior_pvd)."""
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for name, patterns in HEART_RISK_FACTOR_PATTERNS.items():
        if name in seen:
            continue
        for p in patterns:
            if re.search(p, text, re.IGNORECASE):
                seen.add(name)
                found.append(name)
                break
    return found


def score_heart_history(transcript: str) -> tuple[int, str]:
    """Score the H component (0-2) from the patient's chief complaint
    narrative. Returns (points, justification).

    Heuristic: count the number of classical ACS features present.
      - Pressure / tightness / crushing / squeezing
      - Radiation (jaw, arm, back, shoulder)
      - Diaphoresis (sweating)
      - Exertional onset (vs at rest)
    ≥3 features → 2 (highly suspicious)
    1-2 features → 1 (moderately suspicious)
    0 features  → 0 (slightly suspicious)
    """
    if not transcript:
        return (0, "No history to score")
    text = transcript.lower()
    features: list[str] = []
    if re.search(r"\b(?:pressure|tight\w+|squeez\w+|crushing|elephant\s+on\s+(?:my\s+)?chest)\b", text):
        features.append("pressure-quality")
    if re.search(r"\b(?:radiat\w+|spreads|moves|down\s+my\s+arm|into\s+my\s+jaw|"
                 r"to\s+my\s+(?:back|shoulder|arm|jaw))\b", text):
        features.append("radiation")
    if re.search(r"\b(?:sweat\w+|diaphor\w+|cold\s+sweat)\b", text):
        features.append("diaphoresis")
    if re.search(r"\b(?:when\s+(?:I|i)\s+walk|exerc\w+|exerti\w+|climb\w+|"
                 r"after\s+walking|with\s+activity)\b", text):
        features.append("exertional")
    n = len(features)
    if n >= 3:
        return (2, f"Highly suspicious — {n} classical ACS features ({', '.join(features)})")
    if n >= 1:
        return (1, f"Moderately suspicious — {n} classical feature{'s' if n > 1 else ''} ({', '.join(features)})")
    return (0, "Slightly suspicious — no classical features in narrative")


def score_heart_age(age: int | None) -> int:
    """A component (0-2): <45 → 0, 45-64 → 1, ≥65 → 2."""
    if age is None or age < 0:
        return 0
    if age >= 65:
        return 2
    if age >= 45:
        return 1
    return 0


def score_heart_risk_factors(factors: list[str]) -> int:
    """R component (0-2): prior atherosclerotic dx → automatic 2;
    ≥3 factors → 2; 1-2 → 1; none → 0."""
    if any(f in factors for f in ("prior_cad", "prior_cva", "prior_pvd")):
        return 2
    n = len([f for f in factors
             if f in ("htn", "dm", "hld", "smoking", "obesity", "family_hx")])
    if n >= 3:
        return 2
    if n >= 1:
        return 1
    return 0


def compute_clinical_heart(transcript: str, age: int | None) -> dict:
    """Compute the partial (pre-EKG, pre-troponin) HEART score from
    the available triage data. EKG and troponin are pending at the
    bedside and will be added by the clinician.

    Returns a dict the dashboard can render:
      {
        "history": {"points": 1, "justification": "..."},
        "age": {"points": 1, "value": 47},
        "risk_factors": {"points": 1, "found": ["htn", "dm"]},
        "ekg": {"points": null, "note": "Pending bedside ECG"},
        "troponin": {"points": null, "note": "Pending stat troponin"},
        "clinical_total": 3,
        "max_clinical": 6,
        "interpretation": "Intermediate — standard ACS workup indicated",
      }
    """
    h_pts, h_just = score_heart_history(transcript or "")
    a_pts = score_heart_age(age)
    rf = detect_heart_risk_factors(transcript or "")
    r_pts = score_heart_risk_factors(rf)
    total = h_pts + a_pts + r_pts
    return {
        "history": {"points": h_pts, "justification": h_just},
        "age": {"points": a_pts, "value": age},
        "risk_factors": {"points": r_pts, "found": rf},
        "ekg": {"points": None, "note": "Pending bedside ECG"},
        "troponin": {"points": None, "note": "Pending stat troponin"},
        "clinical_total": total,
        "max_clinical": 6,
        "interpretation": _heart_interpretation(total),
    }


def _heart_interpretation(clinical_total: int) -> str:
    """Plain-English read of the partial HEART total. Note: not a
    final-HEART risk tier (those need EKG + troponin). This is just
    the pre-bedside read so the triage chart has SOMETHING to anchor
    expectations on."""
    if clinical_total >= 4:
        return "Concerning for ACS — pursue rapid workup (ECG, troponin)"
    if clinical_total >= 2:
        return "Intermediate — standard ACS workup indicated"
    return "Low pre-test probability (clinical components only)"


def is_chest_pain(chief_complaint: str | None) -> bool:
    """Trigger condition for HEART scoring. Liberal — better to score
    a marginal case than miss one. Reproducible chest-wall pain still
    gets scored; the clinical_total will come back low."""
    if not chief_complaint:
        return False
    cc = chief_complaint.lower()
    return any(k in cc for k in (
        "chest", "heart", "pressure", "tight", "squeez", "crushing",
    ))


# ── Wells score for PE (clinical / pre-imaging) ──────────────────────
# The Wells score for pulmonary embolism is the most-cited PE
# pretest-probability tool in US/UK ED practice. The classic 7-item
# version lives below; we compute a "clinical Wells" from the items
# that are answerable from the triage history alone (DVT signs, prior
# DVT/PE, immobilisation/surgery, hemoptysis, malignancy). Tachycardia
# (HR > 100) and "PE most likely diagnosis" need the bedside vitals
# / clinician judgment respectively, so we surface them as pending.
#
# References:
#   - Wells PS, Anderson DR, Rodger M, et al. "Excluding pulmonary
#     embolism at the bedside without diagnostic imaging: management
#     of patients with suspected pulmonary embolism presenting to the
#     emergency department by using a simple clinical model and
#     d-dimer." Ann Intern Med. 2001;135(2):98-107. (Original 7-item
#     Wells score.)
#   - Endorsed by 2019 ESC PE Guidelines (Konstantinides 2020) and
#     NICE NG158 (2020, reviewed 2023) as a validated PE-probability
#     decision aid.
#   - Also commonly used: PERC rule (Kline 2008) for very-low-risk
#     rule-out, YEARS algorithm (van der Hulle 2017) — both rely on
#     bedside / lab data so out of scope for triage.

# Wells PE risk-factor patterns. The exam item ("clinical signs of
# DVT") is detected via patient self-report of leg swelling /
# unilateral calf pain — a real clinician would inspect and palpate
# but for triage we accept the patient's description as a signal.
WELLS_PE_PATTERNS: dict[str, list[str]] = {
    "dvt_signs": [
        r"\b(?:leg\s+(?:swelling|swollen)|swollen\s+(?:leg|calf)|"
        r"calf\s+(?:pain|tender)|unilateral\s+leg)\b",
    ],
    # Note: "PE most likely diagnosis" (item 2, 3.0 pts) is clinician
    # gestalt — not detectable from history. We omit it from clinical
    # Wells and disclose this to the chart.
    # Note: HR > 100 (item 3, 1.5 pts) is a bedside vital — pending.
    "immobilisation_or_surgery": [
        r"\b(?:bed[\s-]?rest|immobil\w+|on\s+a\s+long\s+(?:flight|drive)|"
        r"long[\s-]haul\s+flight|recent\s+(?:surgery|operation)|"
        r"surgery\s+(?:last|in\s+the\s+past)\s+\w+|"
        r"hospital\s+(?:stay|stayed)|broke(?:n)?\s+\w+\s+(leg|hip|ankle)|"
        r"cast\s+on)\b",
    ],
    "prior_dvt_pe": [
        r"\b(?:i'?ve?\s+had|i\s+had|prior|previous|history\s+of)\s+"
        r"(?:a\s+)?(?:dvt|pe|pulmonary\s+embol\w*|blood\s+clot|"
        r"deep\s+vein\s+thrombos\w*)\b",
    ],
    "hemoptysis": [
        r"\b(?:cough(?:ing)?\s+up\s+blood|hemoptysis|blood\s+in\s+(?:my\s+)?(?:cough|sputum|spit))\b",
    ],
    "malignancy": [
        r"\b(?:cancer|malignan\w*|tumour|tumor|chemo(?:therapy)?|"
        r"on\s+treatment\s+for|metastat\w+|radiation\s+therapy)\b",
    ],
}

# Wells point values (Wells 2001).
_WELLS_POINTS: dict[str, float] = {
    "dvt_signs":                3.0,
    "pe_most_likely":            3.0,  # clinician gestalt — pending
    "tachycardia":               1.5,  # HR > 100 — bedside vital — pending
    "immobilisation_or_surgery": 1.5,
    "prior_dvt_pe":              1.5,
    "hemoptysis":                1.0,
    "malignancy":                1.0,
}


def detect_wells_factors(text: str) -> list[str]:
    """Return Wells-score risk factors mentioned in the patient
    transcript. Only includes factors we can detect from history
    alone — pe_most_likely (clinician gestalt) and tachycardia
    (bedside vital) are NOT included."""
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for name, patterns in WELLS_PE_PATTERNS.items():
        if name in seen:
            continue
        for p in patterns:
            if re.search(p, text, re.IGNORECASE):
                seen.add(name)
                found.append(name)
                break
    return found


def compute_clinical_wells(transcript: str) -> dict:
    """Compute the partial (pre-bedside-vital, pre-clinician-gestalt)
    Wells PE score from triage history. Maximum clinical_total is
    7.5 (out of 12.5) because tachycardia (1.5) and "PE most likely"
    (3.0) require data we don't have at intake.

    Tier interpretation (per Wells 2001 dichotomous cut):
      ≤ 4 points: PE unlikely → consider d-dimer
      > 4 points: PE likely  → consider CTPA / V/Q
    Our clinical_total is a CONSERVATIVE lower bound — the bedside
    update could push the patient into "likely" territory, so we
    flag intermediate scores as "pursue PE workup" rather than rule
    out at this stage.
    """
    factors = detect_wells_factors(transcript or "")
    total = sum(_WELLS_POINTS[f] for f in factors)
    return {
        "score": "Wells",
        "factors_found": factors,
        "factor_points": {f: _WELLS_POINTS[f] for f in factors},
        "pe_most_likely": {"points": None, "note": "Clinician gestalt — pending"},
        "tachycardia": {"points": None, "note": "Pending bedside vitals (HR)"},
        "clinical_total": total,
        "max_clinical": 7.5,
        "max_full": 12.5,
        "interpretation": _wells_interpretation(total, len(factors)),
    }


def _wells_interpretation(clinical_total: float, n_factors: int) -> str:
    if clinical_total >= 4.5:
        return "PE concerning — pursue CTPA / V-Q workup"
    if clinical_total >= 1.5 or n_factors:
        return "Intermediate — d-dimer indicated, watch for HR > 100"
    return "Low pre-test probability (history-only)"


def is_dyspnea_or_pe_concern(chief_complaint: str | None) -> bool:
    """Trigger condition for Wells/PE scoring. Fires for explicit SOB
    complaints AND for chest pain that mentions pleuritic / sharp
    quality (atypical for ACS, classic for PE)."""
    if not chief_complaint:
        return False
    cc = chief_complaint.lower()
    if any(k in cc for k in (
        "breath", "breathing", "short of breath", "sob", "can't breathe",
        "dyspnea", "winded",
    )):
        return True
    # Pleuritic chest pain — sharp/stabbing, worse with breathing
    if "chest" in cc and any(k in cc for k in ("pleuritic", "sharp", "stabbing")):
        return True
    return False


# ── Alvarado score for appendicitis (clinical / pre-bedside) ─────────
# The Alvarado (MANTRELS) score is the classic appendicitis decision
# tool. Original 1986 derivation has limited specificity in modern
# cohorts; AAS (Sammalkorpi 2014) and AIR (Andersson 2008) outperform
# it but require lab data (WBC, CRP) we don't have at triage. We
# implement classic Alvarado for the items detectable from history;
# bedside (RLQ tenderness, rebound, fever) and lab (WBC, left shift)
# are flagged as pending.
#
# References:
#   - Alvarado A. "A practical score for the early diagnosis of
#     acute appendicitis." Ann Emerg Med. 1986;15(5):557-564.
#   - Sammalkorpi HE et al. "A new adult appendicitis score improves
#     diagnostic accuracy of acute appendicitis — a prospective
#     study." BMC Gastroenterol. 2014;14:114. (AAS, more accurate.)
#   - Andersson M, Andersson RE. "The appendicitis inflammatory
#     response score: a tool for the diagnosis of acute appendicitis
#     that outperforms the Alvarado score." World J Surg.
#     2008;32:1843-1849. (AIR, current best for adults.)
#   - ACR Appropriateness Criteria: Right Lower Quadrant Pain (2023
#     update) — guidance on when to image, complementary to scoring.

ALVARADO_PATTERNS: dict[str, list[str]] = {
    # M — Migration of pain to RLQ (1 pt). Patient self-report:
    # "started near my belly button and moved to the right side".
    "migration": [
        r"\b(?:moved\s+(?:to|into)|migrat\w*|started\s+\w+\s+then\s+(?:moved|went)|"
        r"first\s+(?:in|near)\s+\w+\s+(?:then|now)|"
        r"belly\s+button\s+\w*\s*(?:then|now|now\s+it'?s)|"
        r"middle\s+(?:and|then)\s+(?:moved|went))\b",
    ],
    # A — Anorexia (1 pt)
    "anorexia": [
        r"\b(?:no\s+appetite|lost\s+(?:my\s+)?appetite|don'?t\s+feel\s+like\s+eating|"
        r"can'?t\s+eat|haven'?t\s+been\s+eating|anorexi\w+|"
        r"food\s+(?:doesn'?t|does\s+not)\s+(?:appeal|look\s+good))\b",
    ],
    # N — Nausea / vomiting (1 pt)
    "nausea_vomiting": [
        r"\b(?:nause\w+|sick\s+to\s+my\s+stomach|throwing\s+up|vomit\w+|"
        r"have\s+been\s+sick|got\s+sick)\b",
    ],
    # T — Tenderness in RLQ (2 pts) — exam finding, not history
    # R — Rebound tenderness (1 pt) — exam finding, not history
    # E — Elevated temperature ≥ 37.3°C (1 pt) — bedside vital
    # We allow patient self-report of fever as a soft signal:
    "self_reported_fever": [
        r"\b(?:fever|i\s+have\s+a\s+temperature|hot|sweat\w+|chills|"
        r"feverish|burning\s+up)\b",
    ],
    # L — Leukocytosis ≥ 10,000 (2 pts) — lab, NA at triage
    # S — Shift to left of WBC ≥ 75% PMN (1 pt) — lab, NA at triage
}

_ALVARADO_POINTS: dict[str, float] = {
    "migration":              1.0,
    "anorexia":               1.0,
    "nausea_vomiting":        1.0,
    "self_reported_fever":    1.0,  # weaker signal than measured fever
    # Bedside / lab pending:
    "rlq_tenderness":         2.0,
    "rebound_tenderness":     1.0,
    "leukocytosis":           2.0,
    "left_shift":             1.0,
}


def detect_alvarado_factors(text: str) -> list[str]:
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for name, patterns in ALVARADO_PATTERNS.items():
        if name in seen:
            continue
        for p in patterns:
            if re.search(p, text, re.IGNORECASE):
                seen.add(name)
                found.append(name)
                break
    return found


def compute_clinical_alvarado(transcript: str) -> dict:
    """Compute the partial (pre-bedside, pre-lab) Alvarado score from
    triage history. Maximum clinical_total is 4 (out of 10) because
    RLQ tenderness, rebound, WBC, and left shift all need data we
    don't have at intake.

    Tier interpretation (Alvarado 1986 cuts):
      ≤ 3:  appendicitis unlikely
      4-6:  appendicitis possible — observation / imaging
      ≥ 7:  appendicitis likely — surgical consult
    Our clinical_total is a conservative lower bound; the bedside
    + lab additions could push it higher.
    """
    factors = detect_alvarado_factors(transcript or "")
    total = sum(_ALVARADO_POINTS[f] for f in factors)
    return {
        "score": "Alvarado",
        "factors_found": factors,
        "factor_points": {f: _ALVARADO_POINTS[f] for f in factors},
        "rlq_tenderness": {"points": None, "note": "Pending bedside exam"},
        "rebound_tenderness": {"points": None, "note": "Pending bedside exam"},
        "fever_measured": {"points": None, "note": "Pending bedside vital"},
        "leukocytosis": {"points": None, "note": "Pending CBC"},
        "left_shift": {"points": None, "note": "Pending CBC differential"},
        "clinical_total": total,
        "max_clinical": 4.0,
        "max_full": 10.0,
        "interpretation": _alvarado_interpretation(total, len(factors)),
    }


def _alvarado_interpretation(clinical_total: float, n_factors: int) -> str:
    if clinical_total >= 3:
        return "Appendicitis concerning — RLQ exam + CBC + imaging indicated"
    if n_factors >= 1:
        return "Possible — observation + bedside exam"
    return "Low pre-test probability (history-only)"


def is_abdominal_pain(chief_complaint: str | None) -> bool:
    """Trigger condition for Alvarado scoring. Fires for any abdominal
    chief complaint — Alvarado's history items (migration, anorexia,
    n/v) apply broadly to the GI workup, not just suspected appendicitis.
    Low-probability scores correctly read as low-probability."""
    if not chief_complaint:
        return False
    cc = chief_complaint.lower()
    return any(k in cc for k in (
        "abdom", "stomach", "belly", "gut", "rlq", "right lower", "appendix",
    ))
