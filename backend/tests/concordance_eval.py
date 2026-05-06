"""Concordance engine eval harness — false-positive / sensitivity check.

Answers the most-asked judge question: "what's your false-positive rate
on the 70-year-old white man who actually is fine?"

The architecture answer is that the engine is **conjunctive**: a flag
fires only when BOTH a minimisation phrase from the MIMIC-IV-derived
dictionary AND an elevated biomarker signal land in the same window.
This script exercises that property over four stratified case classes
and prints a confusion matrix. The cases are synthetic (matched to
realistic ED triage transcripts) — a real prospective study against
MIMIC-IV-ED triage notes is V2 (see README §Production Roadmap).

Run from the backend dir:
    python -m tests.concordance_eval

Or:
    .venv/bin/python -m tests.concordance_eval
"""
from __future__ import annotations

import sys
from dataclasses import dataclass

from engine.concordance import ConcordanceEngine


@dataclass
class Case:
    label: str          # short description for the report
    cohort: str         # demographic / scenario tag — surfaces in stratified breakdown
    transcript: str
    biomarkers: dict
    should_fire: bool   # ground truth


# ── A. should-fire cases (sensitivity) ──────────────────────────────────────
# Patients who exhibit the under-triage pattern V.I.C.T.O.R. is built to catch:
# verbal minimisation + acoustically elevated voice biomarkers.
SHOULD_FIRE: list[Case] = [
    Case(
        label="Tier 1: minimisation + biomarker breach (canonical demo)",
        cohort="female_atypical_cvd",
        transcript=(
            "I have chest pain. It started 24 hours ago. It feels like pressure. "
            "I don't want to bother anyone, it's probably nothing — sorry to come in."
        ),
        biomarkers={"helios": {"stress": 0.66, "distress": 0.66, "lowSelfEsteem": 0.66}},
        should_fire=True,
    ),
    Case(
        label="Tier 1: abdominal pain in female CVD pattern + minimisation",
        cohort="female_atypical_cvd",
        transcript=(
            "My stomach really hurts. I've been throwing up. I think it's just "
            "indigestion, I don't want to make a fuss but my husband insisted."
        ),
        biomarkers={"helios": {"stress": 0.66, "exhaustion": 0.66, "lowSelfEsteem": 0.66}},
        should_fire=True,
    ),
    Case(
        label="Risk-aware lowered threshold: DM + minimisation + moderate biomarkers",
        cohort="risk_factor_disclosure",
        transcript=(
            "I'm tired and a bit short of breath. I have diabetes. It's probably "
            "nothing — I'm fine, really."
        ),
        biomarkers={"helios": {"stress": 0.33, "exhaustion": 0.33, "distress": 0.33}},
        should_fire=True,
    ),
    Case(
        label="Tier 4 verbal minimisation alone + biomarker breach",
        cohort="elderly_minimiser",
        transcript=(
            "I'm 78. I just feel a bit off, but it'll pass — I didn't want to "
            "come in. My daughter made me."
        ),
        biomarkers={"helios": {"stress": 0.66, "distress": 0.66}},
        should_fire=True,
    ),
    Case(
        label="Family-history risk + minimisation + biomarkers (woman, atypical)",
        cohort="female_atypical_cvd",
        transcript=(
            "I'm exhausted and nauseated. My dad had a heart attack at 50. "
            "I'm sure it's nothing, probably just stress."
        ),
        biomarkers={"helios": {"stress": 0.33, "exhaustion": 0.33, "lowSelfEsteem": 0.66}},
        should_fire=True,
    ),
]

# ── B. should-NOT-fire: direct speech, elevated biomarkers ─────────────────
# This is the "70-year-old white man" cohort the question is asking about.
# Stoic, articulate, non-minimising patients with elevated biomarkers should
# NOT trip the concordance flag — the engine is designed to detect
# verbal/acoustic *mismatch*, not stress alone.
DIRECT_SPEECH_ELEVATED: list[Case] = [
    Case(
        label="70yo white man, classic ACS, direct: NO minimisation",
        cohort="70yo_white_male_typical",
        transcript=(
            "I have severe crushing chest pain, started 30 minutes ago, "
            "radiating to my left arm. I'm sweating. Pain is 9 out of 10."
        ),
        biomarkers={"helios": {"stress": 0.66, "distress": 0.66}},
        should_fire=False,
    ),
    Case(
        label="Stoic elderly male, direct severity report",
        cohort="70yo_white_male_typical",
        transcript=(
            "I have crushing pressure in my chest. Pain 10/10. It started two "
            "hours ago. I want to be evaluated immediately."
        ),
        biomarkers={"helios": {"stress": 0.66, "exhaustion": 0.66}},
        should_fire=False,
    ),
    Case(
        label="Articulate young woman, direct severity, biomarkers elevated",
        cohort="direct_speaker_any_demo",
        transcript=(
            "I have severe abdominal pain, 8 out of 10, in the right lower quadrant. "
            "It started this morning at 7am. I'm worried about appendicitis."
        ),
        biomarkers={"helios": {"stress": 0.66, "distress": 0.66}},
        should_fire=False,
    ),
    Case(
        label="Anxious patient, direct, no minimisation language",
        cohort="anxious_direct",
        transcript=(
            "I'm having chest tightness and I'm scared something is seriously wrong. "
            "Please help me — the pain is real and bad."
        ),
        biomarkers={"helios": {"stress": 0.66, "distress": 0.66, "exhaustion": 0.66}},
        should_fire=False,
    ),
]

# ── C. should-NOT-fire: minimisation but biomarkers normal ─────────────────
# Patient downplays but the voice signal doesn't corroborate distress —
# the engine should NOT fire because there's no biomarker concordance to
# match against. (Catches: "I don't want to bother you" said by someone
# who genuinely is fine.)
MINIMISATION_NORMAL_BIOMARKERS: list[Case] = [
    Case(
        label="Casual minimisation, normal biomarkers (well-being check-in)",
        cohort="minimiser_baseline",
        transcript=(
            "It's probably nothing, I just wanted to get checked out. "
            "I don't want to bother anyone, sorry to come in."
        ),
        biomarkers={"helios": {"stress": 0.0, "distress": 0.0, "exhaustion": 0.0}},
        should_fire=False,
    ),
    Case(
        label="Polite hedging with normal biomarkers",
        cohort="minimiser_baseline",
        transcript=(
            "I'm fine really, just have a small ache. It'll probably pass on its own."
        ),
        biomarkers={"helios": {"stress": 0.33, "distress": 0.0}},
        should_fire=False,
    ),
]

# ── D. should-NOT-fire: neutral speech, normal biomarkers ──────────────────
# Healthy baseline — no minimisation, no biomarker breach. Engine must be
# silent here.
NEUTRAL_BASELINE: list[Case] = [
    Case(
        label="Routine prescription refill conversation",
        cohort="baseline",
        transcript="I'm here for a prescription refill. Same as last time, no changes.",
        biomarkers={"helios": {"stress": 0.0, "distress": 0.0, "exhaustion": 0.0}},
        should_fire=False,
    ),
    Case(
        label="Direct mild complaint, low biomarkers",
        cohort="baseline",
        transcript="I twisted my ankle yesterday. It's swollen and a bit sore.",
        biomarkers={"helios": {"stress": 0.33, "distress": 0.0}},
        should_fire=False,
    ),
]


def evaluate_cohort(name: str, cases: list[Case], engine: ConcordanceEngine) -> tuple[int, int]:
    """Run the engine on each case in a cohort. Returns (correct, total)."""
    print(f"\n── {name} ──")
    correct = 0
    for c in cases:
        flags = engine.evaluate(c.transcript, c.biomarkers)
        fired = bool(flags)
        ok = (fired == c.should_fire)
        correct += ok
        marker = "✓" if ok else "✗"
        verdict = "fired" if fired else "silent"
        expected = "fire" if c.should_fire else "silent"
        tier = f" tier={flags[0].tier}" if flags else ""
        print(f"  {marker} [{c.cohort:30s}] {verdict:6s} (expected {expected:6s}){tier}  {c.label}")
    return correct, len(cases)


def main() -> int:
    engine = ConcordanceEngine()

    print("=" * 80)
    print("V.I.C.T.O.R. concordance engine eval")
    print("=" * 80)
    print()
    print("Architecture: a flag fires IFF (minimisation phrase from MIMIC-IV-derived")
    print("dictionary) AND (biomarker breach above peer-baseline threshold). The")
    print("conjunction is the bias-detection signal — direct speech + elevated")
    print("biomarkers should NOT trip the flag (see cohort B below).")

    cohorts = [
        ("A. Should fire (sensitivity)",                SHOULD_FIRE),
        ("B. Direct speech + elevated biomarkers — 70yo-white-man cohort", DIRECT_SPEECH_ELEVATED),
        ("C. Minimisation language + normal biomarkers",MINIMISATION_NORMAL_BIOMARKERS),
        ("D. Neutral baseline",                          NEUTRAL_BASELINE),
    ]

    totals = []
    for name, cases in cohorts:
        correct, total = evaluate_cohort(name, cases, engine)
        totals.append((name, correct, total))

    # ── Confusion matrix ────────────────────────────────────────────────────
    tp = totals[0][1]
    fn = totals[0][2] - totals[0][1]
    fp = sum(t[2] - t[1] for t in totals[1:])
    tn = sum(t[1]      for t in totals[1:])
    n  = tp + fn + fp + tn

    print()
    print("=" * 80)
    print("Confusion matrix")
    print("=" * 80)
    print(f"  True positives  (correctly fired):    {tp}")
    print(f"  False negatives (missed concordance): {fn}")
    print(f"  False positives (fired on direct/baseline): {fp}")
    print(f"  True negatives  (correctly silent):   {tn}")
    print()

    sens  = tp / (tp + fn) if (tp + fn) else 0.0
    spec  = tn / (tn + fp) if (tn + fp) else 0.0
    fpr   = fp / (fp + tn) if (fp + tn) else 0.0
    ppv   = tp / (tp + fp) if (tp + fp) else 0.0

    print(f"  Sensitivity (TPR):  {sens:>5.1%}   ({tp}/{tp+fn})")
    print(f"  Specificity (TNR):  {spec:>5.1%}   ({tn}/{tn+fp})")
    print(f"  False-positive rate: {fpr:>5.1%}   ({fp}/{fp+tn})")
    print(f"  Positive predictive value: {ppv:>5.1%}   ({tp}/{tp+fp})")
    print()

    pass_rate = (tp + tn) / n
    print(f"  Overall accuracy: {pass_rate:>5.1%}   ({tp+tn}/{n})")
    print()

    # ── Stratified breakdown for the bias-relevant cohort ──────────────────
    print("=" * 80)
    print("Stratified false-positive breakdown")
    print("=" * 80)
    print("  (the cohorts where firing would be a bias signal — 70yo white men")
    print("   who are NOT being under-triaged should never trip the flag)")
    print()

    bias_cohorts: dict[str, list[Case]] = {}
    for c in DIRECT_SPEECH_ELEVATED + MINIMISATION_NORMAL_BIOMARKERS + NEUTRAL_BASELINE:
        bias_cohorts.setdefault(c.cohort, []).append(c)

    for cohort_name, cases in sorted(bias_cohorts.items()):
        fires = 0
        for c in cases:
            if engine.evaluate(c.transcript, c.biomarkers):
                fires += 1
        rate = fires / len(cases) if cases else 0.0
        bar = "█" * int(rate * 20)
        print(f"  {cohort_name:32s}  FPR {rate:>5.1%}  {bar}  ({fires}/{len(cases)})")

    print()
    print("=" * 80)
    print(f"Eval n={n} cases, all synthetic. Real prospective validation against")
    print("MIMIC-IV-ED triage notes with confirmed clinical outcomes is V2.")
    print("=" * 80)

    # Exit code: 0 if all pass, 1 if any miss. Useful for CI gating later.
    return 0 if (fp == 0 and fn == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
