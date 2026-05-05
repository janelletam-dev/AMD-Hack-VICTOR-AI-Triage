"""Concordance Engine — the core innovation.

Detects when patient's spoken words diverge from voice biomarker signals.

Source: MIMIC-IV v3.1 BigQuery analysis (50,000 CVD + 10,000 non-CVD cases).
See VICTOR_MIMIC_Findings_For_Prompts_1.md for tier rationale.

Trigger logic (PRD §7.2):
    IF transcript contains a Tier 1/2 minimisation phrase
    AND any of:
        Helios stress/distress > threshold
        Apollo anxiety > threshold
        CVD biomarkers elevated
    THEN fire concordance flag.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Iterable

log = logging.getLogger("victor.concordance")


# ---------------------------------------------------------------------------
# Tiered minimisation dictionary — sourced from MIMIC-IV CVD-patient triage
# acuity analysis. Acuity values are mean ESI in CVD patients with that
# chief complaint (lower = more urgent; >2.5 = under-triaged in CVD).
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class MinimisationEntry:
    tier: int
    triage_label: str       # clinician shorthand (e.g. "Abd pain")
    acuity: float           # mean MIMIC-IV acuity in CVD patients
    patterns: tuple[str, ...]   # regexes against patient transcript


TIER_1: tuple[MinimisationEntry, ...] = (
    MinimisationEntry(1, "Abd pain, n/v/d", 2.91, (
        r"\bstomach\s+(pain|ache|hurt)",
        r"\bthrowing up\b",
        r"\bbeen\s+vomit",
    )),
    MinimisationEntry(1, "n/v/d", 2.85, (
        r"\bnause(a|ous)\b",
        r"\bvomit",
        r"\bdiarrh",
        r"\bfeel\s+sick\b",
    )),
    MinimisationEntry(1, "Abdominal pain", 2.80, (
        r"\bstomach\s+ache\b",
        r"\bbelly\s+pain\b",
        r"\bmy\s+stomach\s+hurts?\b",
    )),
    MinimisationEntry(1, "Abd pain + diarrhea", 2.78, (
        r"\bstomach\s+pain.+diarrh",
    )),
    MinimisationEntry(1, "ILI", 2.78, (
        r"\bflu\s+symptoms?\b",
        r"\bfeel\s+like\s+i\s+have\s+the\s+flu\b",
    )),
)

TIER_2: tuple[MinimisationEntry, ...] = (
    MinimisationEntry(2, "Hypertension", 2.65, (
        r"\bhigh\s+blood\s+pressure\b",
        r"\bbp\s+is\s+high\b",
    )),
    MinimisationEntry(2, "Nausea/Vomiting", 2.63, (
        r"\bfeeling\s+nauseous\b",
        r"\bbeen\s+vomiting\b",
    )),
    MinimisationEntry(2, "s/p Fall", 2.57, (
        r"\bi\s+fell\b",
        r"\bhad\s+a\s+fall\b",
    )),
)

TIER_3: tuple[MinimisationEntry, ...] = (
    MinimisationEntry(3, "Weakness", 2.46, (
        r"\bfeeling\s+weak\b",
        r"\bno\s+energy\b",
        r"\bjust\s+tired\b",
        r"\bfatigue\b",
    )),
    MinimisationEntry(3, "Epigastric pain", 2.44, (
        r"\bheartburn\b",
        r"\bindigestion\b",
        r"\bupper\s+stomach\b",
    )),
    MinimisationEntry(3, "Headache", 2.69, (
        r"\bbad\s+headache\b",
        r"\bhead\s+pain\b",
    )),
    MinimisationEntry(3, "Leg pain", 2.83, (
        r"\bleg\s+pain\b",
        r"\blegs?\s+hurt\b",
        r"\bswollen\s+leg\b",
    )),
)

# Tier 4 — verbal minimisation patterns (clinical-literature sourced).
TIER_4_PHRASES: tuple[str, ...] = (
    r"\bit'?s\s+nothing\s+really\b",
    r"\bi'?m\s+fine,?\s+just\b",
    r"\bprobably\s+just\s+stress\b",
    r"\bi\s+think\s+it'?s\s+anxiety\b",
    r"\bprobably\s+pulled\s+a\s+muscle\b",
    r"\bit'?ll\s+pass\b",
    r"\bi\s+didn'?t\s+want\s+to\s+bother\b",
    r"\bbeen\s+going\s+on\s+for\s+a\s+while\s+but\b",
)


# ---------------------------------------------------------------------------
# Clinical abbreviation map — translate transcript ↔ clinician shorthand.
# ---------------------------------------------------------------------------

ABBREV_MAP: dict[str, str] = {
    "CP": "Chest pain",
    "SOB": "Shortness of breath",
    "n/v/d": "Nausea, vomiting, diarrhea",
    "BRBPR": "Bright red blood per rectum",
    "SI": "Suicidal ideation",
    "s/p": "Status post (after)",
    "ILI": "Influenza-like illness",
    "Abd": "Abdominal",
}


# ---------------------------------------------------------------------------
# Biomarker thresholds — above these, paired with a minimisation phrase,
# we fire a concordance flag. Tuned conservatively for the demo; calibrate
# against Thymia validation data before any clinical use.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class BiomarkerThresholds:
    """Helios returns bucketed scores at {0.0, 0.33, 0.66, 1.0}.

    Threshold rationale (clinically tuned, not from thymia docs):
      - stress / distress / mentalStrain ≥ 0.66: fire only on the top two
        buckets. Avoids false flags on patients who are just nervous in the ER.
      - exhaustion ≥ 0.33: deliberately looser, because fatigue is one of
        the most commonly missed atypical CVD symptoms in women. MIMIC-IV
        showed weakness/fatigue in female CVD patients averaging acuity 2.46
        — under-triaged.

    Apollo is a separate two-recording product (mood question + read-aloud,
    each ≥15s) and is deferred to end-of-triage; E.L.M.E.R. requests it.
    Its threshold is documented for parity but never read on the hot path.
    """
    helios_stress: float = 0.66
    helios_distress: float = 0.66
    helios_mental_strain: float = 0.66
    helios_exhaustion: float = 0.33   # fatigue = key atypical-CVD signal
    apollo_anxiety: float = 0.50
    cvd_marker: float = 0.50


THRESHOLDS = BiomarkerThresholds()

# When the patient discloses a CVD risk factor (diabetes, hypertension, prior
# MI, smoking, family history, hypercholesterolaemia), we lower the threshold
# so even moderate (0.33-bucket) signals fire a flag. Clinical rationale:
# these patients have higher pre-test probability of cardiac aetiology, so
# the cost of a missed atypical presentation outweighs the cost of an extra
# reassessment.
RISK_AWARE_THRESHOLDS = BiomarkerThresholds(
    helios_stress=0.33,
    helios_distress=0.33,
    helios_mental_strain=0.33,
    helios_exhaustion=0.33,
    apollo_anxiety=0.33,
    cvd_marker=0.33,
)


# CVD risk-factor patterns. Match against the running transcript; surface
# any hits to M.E.R.C.E.D. so it can mention them in the gloss, and to
# V.I.C.T.O.R. so it can swap to the lowered thresholds.
@dataclass(frozen=True)
class RiskFactor:
    label: str          # short label for display ("diabetes", "hypertension", …)
    patterns: tuple[str, ...]


CVD_RISK_FACTORS: tuple[RiskFactor, ...] = (
    RiskFactor("diabetes", (
        r"\bdiabet(es|ic)\b",
        r"\btype\s*(1|2|i|ii|one|two)\s*diabet",
        r"\bhigh\s+blood\s+sugar\b",
        r"\binsulin\b",
        r"\bmetformin\b",
    )),
    RiskFactor("hypertension", (
        r"\bhypertens",
        r"\bhigh\s+blood\s+pressure\b",
        r"\bbp\s+is\s+(high|up)\b",
        r"\bblood\s+pressure.*high\b",
        r"\b(lisinopril|amlodipine|losartan|metoprolol|atenolol|hydrochlorothiazide)\b",
    )),
    RiskFactor("prior MI", (
        r"\b(heart\s+attack|myocardial\s+infarction|m\.?i\.?)\b",
        r"\bheart\s+(stent|bypass|surgery)\b",
        r"\bcoronary\s+(stent|bypass|artery\s+disease|cad)\b",
        r"\bafib\b|\batrial\s+fibrillation\b",
        r"\bheart\s+failure\b|\bchf\b",
    )),
    RiskFactor("smoking", (
        r"\bsmok(e|er|ing)\b",
        r"\bcigarett",
        r"\bvape\b|\bvaping\b",
        r"\bnicotin",
        r"\bpack\s+a\s+day\b|\b(\d+)\s+packs?\s+(a|per)\s+day\b",
    )),
    RiskFactor("family history of CVD", (
        r"\b(my\s+)?(dad|father|mom|mother|brother|sister|parent|grand(father|mother|pa|ma))\b.*\b(heart|cardiac|stroke)\b",
        r"\bfamily\s+history\s+of\s+(heart|cardiac|cvd)\b",
        r"\b(dad|father|mom|mother).*\b(heart\s+attack|m\.?i\.?|bypass)\b",
    )),
    RiskFactor("high cholesterol", (
        r"\bhigh\s+cholesterol\b",
        r"\bhyperlipidaemia\b|\bhyperlipidemia\b",
        r"\b(statin|atorvastatin|simvastatin|rosuvastatin|crestor|lipitor)\b",
    )),
)


def detect_risk_factors(transcript: str) -> list[str]:
    """Return the list of CVD-risk-factor labels mentioned in the transcript."""
    if not transcript:
        return []
    hits: list[str] = []
    for rf in CVD_RISK_FACTORS:
        for pat in rf.patterns:
            if re.search(pat, transcript, re.IGNORECASE):
                hits.append(rf.label)
                break
    return hits


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

@dataclass
class ConcordanceFlag:
    tier: int
    trigger_phrase: str
    triage_label: str
    acuity: float
    biomarker_signal: str
    gloss_seed: str = ""    # the structured seed; M.E.R.C.E.D. expands to prose
    matches: list[str] = field(default_factory=list)
    # CVD risk factors mentioned in the transcript (e.g. ["diabetes",
    # "smoking"]). Surfaced to M.E.R.C.E.D. so the gloss reflects elevated
    # pre-test probability, and to V.I.C.T.O.R. so escalation reasoning
    # can cite them.
    risk_factors: list[str] = field(default_factory=list)
    # True if these flags were evaluated under the lowered thresholds
    # because risk factors were present.
    risk_aware: bool = False


class ConcordanceEngine:
    """Stateless evaluator. Call `evaluate()` with the latest transcript
    window and biomarker snapshot; get back zero or more flags."""

    def __init__(self, thresholds: BiomarkerThresholds = THRESHOLDS) -> None:
        self.thresholds = thresholds
        self._all_entries: tuple[MinimisationEntry, ...] = TIER_1 + TIER_2 + TIER_3
        self._compiled: list[tuple[MinimisationEntry, list[re.Pattern]]] = [
            (e, [re.compile(p, re.IGNORECASE) for p in e.patterns])
            for e in self._all_entries
        ]
        self._tier4 = [re.compile(p, re.IGNORECASE) for p in TIER_4_PHRASES]

    def find_minimisation(self, transcript: str) -> list[tuple[MinimisationEntry, list[str]]]:
        """Return entries whose patterns matched, with the matched substrings."""
        hits: list[tuple[MinimisationEntry, list[str]]] = []
        for entry, patterns in self._compiled:
            matches = [m.group(0) for p in patterns for m in p.finditer(transcript)]
            if matches:
                hits.append((entry, matches))
        return hits

    def find_tier4(self, transcript: str) -> list[str]:
        return [m.group(0) for p in self._tier4 for m in p.finditer(transcript)]

    def biomarker_elevated(self, snapshot: dict) -> tuple[bool, list[str]]:
        """Return (elevated?, list of human-readable signal descriptions).

        Reads the Helios shape returned by ThymiaService:
          { stress, distress, exhaustion, sleepPropensity, lowSelfEsteem, mentalStrain }
        Apollo / CVD blocks are still inspected if a future caller adds them.
        """
        signals: list[str] = []
        helios = snapshot.get("helios", {}) or {}
        apollo = snapshot.get("apollo", {}) or {}
        cvd = snapshot.get("cvd", {}) or {}

        # Use `>=` not `>` so a bucketed value of exactly 0.66 (which is what
        # Helios returns for the second-highest bucket) actually fires.
        if helios.get("stress", 0.0) >= self.thresholds.helios_stress:
            signals.append(f"stress: {helios['stress']:.2f}")
        if helios.get("distress", 0.0) >= self.thresholds.helios_distress:
            signals.append(f"distress: {helios['distress']:.2f}")
        if helios.get("exhaustion", 0.0) >= self.thresholds.helios_exhaustion:
            signals.append(f"exhaustion: {helios['exhaustion']:.2f}")
        if helios.get("mentalStrain", 0.0) >= self.thresholds.helios_mental_strain:
            signals.append(f"mental strain: {helios['mentalStrain']:.2f}")
        if apollo.get("anxiety", 0.0) >= self.thresholds.apollo_anxiety:
            signals.append(f"anxiety: {apollo['anxiety']:.2f}")
        for k, v in cvd.items():
            if v >= self.thresholds.cvd_marker:
                signals.append(f"{k}: {v:.2f}")
        return (bool(signals), signals)

    def evaluate(
        self, transcript: str, biomarkers: dict
    ) -> list[ConcordanceFlag]:
        """Return concordance flags for the given window.

        If the transcript mentions any CVD risk factor (diabetes, hypertension,
        prior MI, smoking, family history, hypercholesterolaemia), we evaluate
        biomarkers under the LOWERED thresholds — these patients deserve
        extra scrutiny even at moderate (0.33-bucket) signal levels.
        """
        risk_factors = detect_risk_factors(transcript)
        risk_aware = bool(risk_factors)
        thresholds = RISK_AWARE_THRESHOLDS if risk_aware else self.thresholds

        # Save the active thresholds onto self temporarily so biomarker_elevated
        # picks up the right cutoff. Restored after evaluation.
        original = self.thresholds
        try:
            self.thresholds = thresholds
            elevated, signals = self.biomarker_elevated(biomarkers)
        finally:
            self.thresholds = original

        if not elevated:
            return []

        flags: list[ConcordanceFlag] = []
        signal_str = ", ".join(signals)
        rf_clause = (
            f" Risk factors disclosed: {', '.join(risk_factors)}."
            if risk_factors else ""
        )

        for entry, matches in self.find_minimisation(transcript):
            seed = (
                f"Patient presents with {entry.triage_label.lower()} "
                f"(MIMIC-IV mean acuity {entry.acuity:.2f} in CVD patients). "
                f"Voice biomarkers indicate {signal_str}.{rf_clause} "
                f"Recommend reassessment for atypical CVD presentation."
            )
            flags.append(
                ConcordanceFlag(
                    tier=entry.tier,
                    trigger_phrase=matches[0],
                    triage_label=entry.triage_label,
                    acuity=entry.acuity,
                    biomarker_signal=signal_str,
                    gloss_seed=seed,
                    matches=matches,
                    risk_factors=risk_factors,
                    risk_aware=risk_aware,
                )
            )

        # Tier-4 verbal minimisation: lower-confidence flag, only if no
        # higher-tier hit already fired.
        if not flags:
            for phrase in self.find_tier4(transcript):
                flags.append(
                    ConcordanceFlag(
                        tier=4,
                        trigger_phrase=phrase,
                        triage_label="Verbal minimisation",
                        acuity=0.0,
                        biomarker_signal=signal_str,
                        gloss_seed=(
                            f"Patient verbally minimises symptoms ('{phrase}') "
                            f"while voice biomarkers indicate {signal_str}.{rf_clause} "
                            f"Recommend deeper symptom elicitation."
                        ),
                        matches=[phrase],
                        risk_factors=risk_factors,
                        risk_aware=risk_aware,
                    )
                )

        return flags


def expand_abbreviations(text: str, mapping: dict[str, str] = ABBREV_MAP) -> str:
    """Translate clinical shorthand to plain language for patient-facing copy."""
    out = text
    for short, long in mapping.items():
        out = re.sub(rf"\b{re.escape(short)}\b", long, out)
    return out


# Singleton for app-wide use.
engine = ConcordanceEngine()
