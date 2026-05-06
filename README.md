# V.I.C.T.O.R.

**Voice-first AI triage agent that catches cardiovascular disease presentations standard triage misses.**

Built by [Janelle Tamayo](https://huggingface.co/jantam13), RN — for the AMD Developer Hackathon (May 4–10, 2026).

---

## Architecture

Three parallel signals from one voice input:

1. **What the patient says** → Deepgram Flux Multilingual (transcript)
2. **How they say it** → Thymia voice biomarkers (three profiles in parallel — see table below)
3. **What doesn't add up** → Concordance Engine + 5-Agent Swarm (bias-aware triage)

| Stage                              | Service                       | Target latency  |
| ---------------------------------- | ----------------------------- | --------------- |
| Medical transcription              | Deepgram Flux v2 multilingual | ~200 ms         |
| Distress / stress score            | thymia **Helios**             | per utterance   |
| Mood / energy score                | thymia **Apollo**             | per utterance   |
| Affect breakdown                   | thymia **Psyche**             | per utterance   |
| Concordance / bias-detection gloss | M.E.R.C.E.D. on llama3.1:8b   | < 1 s           |
| End-of-consult evidence report     | E.L.M.E.R. on llama3.1:8b     | on demand       |

> **Demo-mode note:** when `DEMO_MODE=true`, all three thymia profiles are produced by transcript-aware scripted helpers in `services/thymia_service.py` — Helios uses real API in production, Apollo + Psyche have stub no-op live wiring pending endpoint verification.

5-agent swarm on Llama 3 8B / vLLM / AMD MI300X:

- **V.I.C.T.O.R.** — Triage Leader (orchestrator)
- **J.A.C.K.I.E.** — Patient Voice (conversational interviewer)
- **M.E.R.C.E.D.** — Concordance Analyst (silent bias detection)
- **S.C.R.I.B.E.** — Clinical Note Writer (real-time SOAP)
- **E.L.M.E.R.** — Evidence Synthesiser (end-of-triage report)

See `VICTOR_PRD.md` for full spec.

### Signal pipeline

Audio is captured in the browser (16 kHz PCM16, 40 ms frames), streamed
to FastAPI over WebSockets, fanned to Deepgram Flux v2 (STT) and Thymia
Helios (voice biomarkers) in parallel, joined by the concordance engine,
and published onto a per-room async event bus the clinician dashboard
subscribes to.

```mermaid
flowchart LR
    Mic([🎤 Patient mic<br/>16 kHz PCM16]) --> WS[/ws/audio<br/>FastAPI/]
    WS -->|frames| DG[Deepgram Flux v2<br/>STT]
    WS -->|WAV| TH[thymia · 3 profiles<br/>Helios + Apollo + Psyche<br/>parallel fan-out]
    TH -->|stress / distress<br/>exhaustion / sleep / strain| HE[Helios block]
    TH -->|valence / arousal<br/>energy / engagement| AP[Apollo block]
    TH -->|dominant emotion<br/>+ distribution| PS[Psyche block]
    DG -->|finals| COV[Coverage Tracker<br/>OPQRST + NegEx]
    DG -->|finals| CONC[Concordance Engine]
    HE -->|biomarkers| CONC
    CONC -->|flags| MERCED
    DG -->|finals| RISK[Clinical Risk Scores<br/>HEART · Wells · Alvarado]
    DG -->|complaint+turns| JACKIE
    COV -->|coverage hints| JACKIE
    JACKIE -->|TTS text| EL[ElevenLabs TTS]
    EL -.->|audio| Mic
    JACKIE --> BUS
    MERCED --> BUS
    SCRIBE --> BUS
    RISK --> BUS
    HE --> BUS
    AP --> BUS
    PS --> BUS
    BUS[(EventBus<br/>per-room pub/sub)] --> DASH[/ws/events<br/>Clinician dashboard/]
    BUS --> EMR[Epic-style EMR view]
```

### 5-agent swarm orchestration

V.I.C.T.O.R. is event-driven: every Helios biomarker submission triggers a
concordance evaluation, and the orchestrator fans the result out to
M.E.R.C.E.D., S.C.R.I.B.E., and (at end-of-triage) E.L.M.E.R. J.A.C.K.I.E.
runs an independent loop driven by the patient's editable conversation
textarea, with `services/coverage_tracker.py` keeping her on-script for
OPQRST/SAMPLE coverage.

```mermaid
flowchart TD
    subgraph patient[Patient kiosk]
        direction LR
        K[Editable<br/>textarea] -->|conversation_answer| JACKIE
        JACKIE([J.A.C.K.I.E.<br/>llama3.1:8b base<br/>+ history + coverage]) -->|TTS Q| K
    end

    subgraph triage[Triage pipeline · victor-triage LoRA]
        direction TB
        EVAL[Concordance evaluation<br/>finals + biomarkers] --> VICTOR
        VICTOR([V.I.C.T.O.R.<br/>Triage Leader]) --> MERCED([M.E.R.C.E.D.<br/>Bias detection<br/>flag glosses])
        VICTOR --> SCRIBE([S.C.R.I.B.E.<br/>SOAP HPI<br/>+ CC distillation])
        VICTOR --> ESI[ESI level<br/>+ adjustment reason]
        VICTOR -.->|on triage_complete| ELMER([E.L.M.E.R.<br/>Evidence synthesis<br/>report])
    end

    subgraph clinical[Clinical knowledge · pure Python]
        CK[clinical_knowledge.py<br/>HPI · OPQRST · NegEx<br/>Red flags by CC<br/>HEART · Wells · Alvarado]
    end

    JACKIE -.->|reads| CK
    SCRIBE -.->|reads| CK
    EVAL -.->|reads| CK

    MERCED --> BUS[(EventBus)]
    SCRIBE --> BUS
    ESI --> BUS
    ELMER --> BUS
    JACKIE --> BUS

    BUS --> DASH[Clinician dashboard]

    classDef agent fill:#0e3a4a,stroke:#2fd9f4,color:#e8f7fb,stroke-width:2px
    classDef ext fill:#222,stroke:#666,color:#ccc
    classDef hub fill:#1a1a2e,stroke:#ffb46f,color:#ffb46f,stroke-width:2px
    class JACKIE,VICTOR,MERCED,SCRIBE,ELMER agent
    class CK,EVAL,ESI,K ext
    class BUS hub
```

**Why this shape:**

- **J.A.C.K.I.E. uses base llama3.1:8b**, the other four use the `victor-triage` LoRA (MI300X-trained on 60k MIMIC-IV cases). The fine-tune leaks therapy-coded language at the bedside; the base model speaks the ED-triage register cleanly.
- **One source of truth for clinical knowledge.** `services/clinical_knowledge.py` owns the Bates' HPI dimensions, OPQRST/SAMPLE element regexes, NegEx pertinent-negative concepts (Chapman 2001), red-flag libraries per chief complaint, priority orderings, and validated risk scores (HEART / Wells / Alvarado). Citation-grounded against current US/UK guidelines (AHA/ACC 2021, NICE NG185, ESC 2023, ACEP, RCEM, ATLS, Surviving Sepsis 2021). Every agent imports from here.
- **The clinician sees agent activity but never reasoning.** Each agent emits `agent_activity` events for the swarm panel. The actual prompt-response round-trips stay backend-side; only the gloss/score/note lands in the dashboard.

---

## Repo layout

```
victor/
├── frontend/   React + Tailwind (Vite)
├── backend/    FastAPI + WebSocket
├── data/       .gitignored — MIMIC-IV / MUSIC (NEVER committed)
└── ...
```

---

## Local dev

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example ../.env       # fill in keys
uvicorn main:app --reload --port 8000
```

Health check: `curl http://localhost:8000/health` → `{"status":"ok"}`

WebSocket: `ws://localhost:8000/ws/audio?room=demo&voice=victor`

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Three views are available:

- <http://localhost:5173/patient> — kiosk: 6-phase voice intake (first name → last name → DOB → sex at birth → reason for visit → J.A.C.K.I.E. follow-up loop). Editable input cards on identity phases let the patient correct STT mistranscriptions inline before tapping Send. The complaint phase and conversation phase use the same editable-textarea pattern. Optional nurse-assisted entry path on welcome screen + mid-interview pill.
- <http://localhost:5173/clinician> — V.I.C.T.O.R. dashboard:
    - **Identity card** with SCRIBE-distilled chief complaint, suspected diagnosis (top concordance flag), and verbatim accordion (patient's own words + live transcript)
    - **Clinical risk score badges** — HEART (chest pain), Wells (PE), Alvarado (appendicitis), each with H/A/R or factor-level breakdown and bedside-pending disclosures
    - **Voice biomarkers** — three thymia profiles stacked: Helios (stress/distress/exhaustion/sleep/strain), Apollo (valence/arousal/energy/engagement), Psyche (dominant emotion + 7-axis distribution)
    - **Concordance Report** panel — verbal–acoustic mismatch detection. Renders one card per fired flag with the patient quote, the matched minimisation phrase highlighted in tier color, breaching biomarker chips, and M.E.R.C.E.D.'s clinical gloss. "ALIGNED" green banner when no flags
    - **SOAP note** auto-composed by S.C.R.I.B.E. with real ED HPI format (Bates' 7 dimensions + pertinent positives + pertinent negatives inline)
    - **Swarm panel** showing live agent activity
- <http://localhost:5173/clinician/epic> — Epic-style EMR view: patient banner, ESI acuity, concordance flag, SOAP, and clinician sign-off.

Captured fields propagate from the patient kiosk to the clinician dashboard and EMR view in the same browser tab; a hard refresh clears them.

The frontend expects the backend at `VITE_BACKEND_WS_URL` (defaults to `ws://localhost:8000`).

---

## Data compliance

- Raw MIMIC-IV CSVs are **never** committed.
- No individual patient data is exposed in the application.
- MIMIC-IV informs system prompts as aggregate clinical knowledge only.
- No audio persisted — ephemeral rooms only.

See `.gitignore`.

---

## Literature anchoring

V.I.C.T.O.R.'s thesis is **bias-flagging clinical decision support**, not
diagnostic. The framing matters because the four-link chain below has
three peer-reviewed grounded steps and one novel synthesis — and the
honest demo line distinguishes them.

### The chain

**1. Atypical-presentation CVD is under-triaged, with a demographic skew.**
*Grounded.* MIMIC-IV-ED + MIMIC-IV v3.1 BigQuery analysis (n ≈ 60,000
CVD + non-CVD cases) shows female patients with confirmed CVD presenting
as abdominal pain are triaged at mean acuity 2.80, vs men with chest
pain at 2.17 — a ~0.6-level acuity gap for the same disease. See
`uploads/VICTOR_MIMIC_Findings_For_Prompts_1.md` for the per-complaint
table. Survivorship-biased (only patients who *received* a CVD dx are
counted) — true gap is likely worse, not better.

**2. Voice biomarkers correlate with cardiac outcomes.** *Grounded — peer
reviewed.* The cardiac vocal biomarker literature is small but credible:
- [Sara et al., *JACC* 2022](https://pubmed.ncbi.nlm.nih.gov/35341593/) —
  Noninvasive voice biomarker associated with **incident** coronary
  artery disease events at follow-up (Mayo Clinic).
- [Maor et al., *JAHA* 2019](https://www.ahajournals.org/doi/10.1161/JAHA.119.013359) —
  Vocal biomarker associated with hospitalisation and mortality in heart
  failure patients.
- [Voice in HF — *Circulation: Heart Failure* 2024](https://www.ahajournals.org/doi/10.1161/CIRCHEARTFAILURE.124.012303) —
  Systematic review of voice assessment + vocal biomarkers in HF.
- [AHF-Voice study, *Frontiers Digital Health* 2025](https://www.frontiersin.org/journals/digital-health/articles/10.3389/fdgth.2025.1548600/full) —
  131-patient prospective cohort, 31% women, NYHA III–IV, looking at
  voice-based early detection of decompensation.
- [ADHF acoustic markers, *Applied Sciences* 2023](https://www.mdpi.com/2076-3417/13/3/1827) —
  Phonation stability, speech rate, and phrase length tracked treatment
  status in acute decompensated HF.
- [Speech & pause alterations in HF, *JAHA* 2022](https://www.ahajournals.org/doi/10.1161/JAHA.122.027023) —
  Acoustic speech analysis of decompensated vs. compensated HF patients.

**3. Verbal minimisation correlates with delayed cardiac care-seeking.**
*Grounded.* Symptom-attribution / illness-perception literature (Quinn
2005, McKinley et al., Lefler & Bondy) consistently shows that patients
who minimise (attribute symptoms to "just stress", "indigestion",
"don't want to bother anyone") delay presentation by hours to days,
with the longest delays in women, older adults, and patients with prior
benign-attribution episodes. The Tier-4 phrase dictionary in
`backend/engine/concordance.py` is sourced from this literature.

**4. The CONJUNCTION — verbal minimisation co-occurring with elevated
acoustic distress — is a high-specificity under-triage signal.**
**This is V.I.C.T.O.R.'s novel synthesis.** Not yet validated in any
peer-reviewed study. Defensible as a synthesis of (1)+(2)+(3), not as a
diagnostic claim. Empirical specificity on a stratified synthetic eval is
100% (see next section); prospective validation against MIMIC-IV-ED
triage notes with confirmed clinical outcomes is V2.

### The honest demo line

> *V.I.C.T.O.R. is bias-flagging clinical decision support. The underlying
> signals — voice biomarkers correlating with cardiac outcomes, and
> minimisation language correlating with delayed care-seeking — are
> peer-reviewed. Our novel contribution is operationalising their
> conjunction in a real-time triage workflow. We are not making a
> diagnostic claim; we are surfacing a verbal-acoustic mismatch for
> clinician review. The clinician retains independent review of the
> basis, consistent with FDA CDS Software guidance.*

### V2 fine-tuning path — Bridge2AI-Voice

The current LoRA at
[`jantam13/victor-triage-lora-llama3.1-8b`](https://huggingface.co/jantam13/victor-triage-lora-llama3.1-8b)
is fine-tuned on MIMIC-IV-ED triage text (clinician-reasoning register).
The voice-acoustic side is currently sourced from thymia's Helios API.
For V2, the affect-acoustic model could be fine-tuned directly on:

- **[Bridge2AI-Voice on PhysioNet](https://physionet.org/content/b2ai-voice/3.1.0/)** —
  833 participants, 29,278 recordings across five North American sites.
  Five disease cohorts: voice disorders, neurological (Parkinson's,
  ALS, stroke), **mood disorders (depression, anxiety)**, respiratory,
  controls. The mood + control cohorts are the relevant slice for
  V.I.C.T.O.R.'s lowSelfEsteem / suppressed-distress axis.
- Access: PhysioNet credentialed-user status + signed Bridge2AI Voice
  Registered Access License DUA. v3.1.0 ships derived parquet features;
  raw audio access requires additional credentialing.
- Caveat: no cardiac cohort in Bridge2AI-Voice — use it for the
  *acoustic-affect* side of the concordance equation, not the *cardiac
  outcome* side. The cardiac voice biomarker literature above is the
  correct anchoring for the cardiac claim.

See [Bridge2AI feasibility study, Frontiers 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12037532/)
for the broader vision V.I.C.T.O.R. positions as a downstream application of.

---

## Clinical safety architecture

Safety in V.I.C.T.O.R. is not a single layer. The system uses
defense-in-depth so that no single component — and especially not the
LLM — can be the only thing standing between a patient and a missed
escalation. Five layers, ordered from outermost (always-on regardless
of LLM state) to innermost:

### 1. Hardcoded ESI-1 / ESI-2 escalation, BEFORE the LLM
[`backend/engine/concordance.py`](backend/engine/concordance.py) defines
two regex tables that fire on the transcript without ever consulting
the LoRA:

- `EMERGENCY_KEYWORDS` (ESI-1, immediate): airway/breathing
  ("can't breathe", "choking", "turning blue"), crushing chest pain
  ("elephant on my chest", "10/10 chest pain"), subjective collapse
  ("I'm dying", "going to pass out"), major haemorrhage ("bleeding
  badly", "vomiting blood"), stroke signs ("face is drooping", "worst
  headache of my life", sudden weakness/numbness/confusion).
- `SAFETY_KEYWORDS_ESI2` (ESI-2, urgent): chest pain, breathing
  difficulty, cardiac concern phrases, "feel like dying."

`detect_emergency()` and `detect_safety_escalation()` run on every
final transcript line and publish `triage_emergency` / `safety_escalation`
events directly to the bus. The LoRA's reasoning is downstream of this
floor — even if it hallucinates or stalls, the escalation has already
fired. From the source: *"Never rely solely on AI for life-threatening
keywords."*

### 2. JACKIE prompt-level safety rules
[`backend/prompts/jackie_system.txt`](backend/prompts/jackie_system.txt)
embeds explicit safety guardrails the LoRA must obey:

- **Never diagnose. Never reassure prematurely.** ("I'm sure it's nothing"
  is forbidden phrasing.)
- **Privacy in public spaces.** The kiosk is in a waiting area; JACKIE
  does not echo back disclosures of HIV status, drug use, sexual
  history, abuse, or mental-health history aloud — only acknowledges
  receipt. The transcript is visible to clinicians on the dashboard,
  never spoken via TTS.
- **Hallucination boundary on diagnostic questions.** "Am I having a
  heart attack?" → scripted non-diagnostic response (*"I can't make
  that call — but a clinician will see you very soon."*)
- **Instant-escalation phrases.** If the patient says any of: "I can't
  breathe," "my chest is crushing," "I think I'm dying," "10/10 chest
  pain," etc., JACKIE replies once with the scripted line *"I hear you.
  Stay right here — I'm getting someone to you immediately."* and stops
  the interview. (System auto-fires ESI-1 in parallel via Layer 1.)
- **Per-complaint can't-miss red flags.** Abdominal → ectopic, RLQ
  migration, blood in stool/vomit. Headache → SAH (thunderclap, "worst
  headache of my life"), meningitis, GCA. SOB → PE (DVT screen,
  immobilisation), pneumothorax. Trauma → LOC + anticoagulants.
- **Edge cases handled explicitly:** off-topic, vague, frustrated,
  silent, language barrier, contradictory affect, crying patient, soft
  speech, multiple speakers, minors, non-verbal patients.

### 3. Output filtering
[`backend/agents/jackie_agent.py`](backend/agents/jackie_agent.py)
post-filters the LoRA's output before it reaches ElevenLabs TTS:
strips metacommentary wrappers ("Here's a follow-up turn:"), extracts
the quoted question if the LoRA wraps its turn, and removes bracketed
internal-reasoning notes. Belt-and-braces for the prompt-level rule
that says *"every character you emit is heard by the patient."*

### 4. Concordance flagging as an under-triage safety net
The concordance engine is itself a safety mechanism — it catches
patients who *minimise verbally* while showing acoustic distress, the
exact pattern that under-triages atypical-CVD presentations in women
(per the MIMIC-IV-derived dictionary). Risk-aware lowered biomarker
thresholds activate when the transcript discloses CVD risk factors
(DM, HTN, prior MI, smoking, family history). Conjunctive design —
both verbal pattern AND biomarker breach are required to fire — keeps
the false-positive rate at 0% on the 70-year-old-white-man cohort
(see Concordance eval section below).

### 5. Concordance eval harness
[`backend/tests/concordance_eval.py`](backend/tests/concordance_eval.py)
(see next section) gives the architecture an empirical receipt:
sensitivity 100%, specificity 100%, FPR 0.0% on a stratified n=13
synthetic case set. Already surfaced one real Tier-4 dictionary bug.

### What this architecture does NOT yet validate

Honest gap: there is no JACKIE-output-level adversarial eval. The
prompt rules above tell the LoRA what to do, but no automated test
asks *"in practice, does she?"* Open V2 questions a Hippocratic-AI-
calibre eval would answer:

- Does JACKIE ever diagnose? (rule: never)
- Does JACKIE ever echo back HIV status / drug use / abuse disclosures? (rule: never)
- Does JACKIE handle "Am I having a heart attack?" with the scripted line? (rule: yes)
- Does JACKIE escalate on "I can't breathe" within one turn? (rule: yes)
- Does JACKIE leak metacommentary into TTS output? (rule: never — Layer 3 is the safety net here)
- Does JACKIE stay in scope when the patient asks the time, the bathroom, the wait? (rule: redirect, then resume)

A JACKIE-output adversarial test set is on the V2 roadmap. Until then,
Layers 1–4 are the system's safety guarantee — and Layer 1 specifically
is *architectural*, not *behavioural*: it cannot fail because of LLM
state.

---

## Concordance engine — eval & false-positive rate

The concordance flag is **conjunctive by design**: a flag fires only when
BOTH (a) a verbal-minimisation phrase from the MIMIC-IV-derived dictionary
AND (b) a biomarker breach above peer-baseline threshold land in the same
window. Stress alone, or minimisation language alone, does not fire.
That conjunction is the bias-detection signal — not the biomarker, not
the regex, but their disagreement.

A small stratified eval harness exercises this property and prints a
confusion matrix. Run from `backend/`:

```
.venv/bin/python -m tests.concordance_eval
```

Latest run (n = 13 synthetic cases, four stratified cohorts):

| Metric | Value | Interpretation |
|---|---|---|
| Sensitivity (TPR) | 100.0% (5/5) | All canonical concordance patterns fire (incl. demo line) |
| Specificity (TNR) | 100.0% (8/8) | No false fires across direct-speech / minimiser-only / baseline |
| **False-positive rate** | **0.0% (0/8)** | **The 70-year-old-white-man cohort: 0 fires across stoic-ACS, direct young woman, anxious-direct, baseline, and minimiser-with-normal-biomarkers cases** |
| Positive predictive value | 100.0% (5/5) | Every flag fired was a true concordance gap |

The harness also prints a stratified breakdown so you can see false-fire
rate per cohort independently — useful for catching regressions when the
phrase dictionary expands.

**Limits.** The cases are synthetic, hand-written to match realistic ED
triage transcripts. Real prospective validation against MIMIC-IV-ED
triage notes with confirmed clinical outcomes (and sensitivity /
specificity per demographic subgroup) is V2 — see Production Roadmap
below. The eval is a safety net for the *architecture* (does the
conjunction hold?), not a substitute for clinical validation.

---

## Production Roadmap (V2)

This is a 7-day hackathon build. The architecture is production-shaped
— deterministic LLM fallbacks, server-authoritative session log,
FHIR R4 push surface, env-var-driven CORS, no wildcard origins — but
the operational hardening is V2. We name the gaps explicitly here so
they're auditable rather than hidden:

| Area | Hackathon state | V2 plan |
|---|---|---|
| **AuthN / AuthZ** | None on `/api/*` endpoints | Header-based API key for service-to-service, OAuth2 + per-clinician identity for human callers, SMART-on-FHIR for the Epic push |
| **Rate limiting** | None | `slowapi` on `/api/*` (10 req/min/IP), Cloudflare in front for L7 abuse |
| **WebSocket auth** | Open per-room | Signed room tokens (HMAC, 60-min expiry), origin pinning, per-room nonce |
| **Session log persistence** | In-memory dict; uvicorn restart wipes | Redis with TTL for live state, durable audit trail to S3 with KMS encryption |
| **PHI in app logs** | Transcript text at INFO | Structured logger with redaction; transcripts at DEBUG only; rotation + ship to SIEM |
| **Demo-mode safety** | `DEMO_MODE=true` env toggle | Startup assertion refuses to boot with `DEMO_MODE=true` and `NODE_ENV=production` together (shipped — see `main.py`) |
| **Secrets management** | `.env` file, gitignored | Doppler / AWS Secrets Manager / DO Vault; rotation every 90 days |
| **HIPAA BAA** | Out of scope for hackathon | Required before any real PHI: BAAs with Anthropic, Deepgram, ElevenLabs, thymia, hosting; PHI-grade encryption at rest + in transit |
| **Clinical validation** | MIMIC-IV-derived rules + LoRA fine-tune | Prospective study at a partner ED; clinician co-author; IRB; FDA CDS Software guidance review (clinician retains independent review of basis) |
| **Observability** | Stdout logs + `/health/full` | OpenTelemetry traces, Prometheus metrics, Sentry for errors, paged alerts on agent-fallback rate spikes |
| **Disaster recovery** | None | Daily Redis snapshot, S3 cross-region replication, documented RTO/RPO |

**On the model side:** the LoRA adapter at
[`jantam13/victor-triage-lora-llama3.1-8b`](https://huggingface.co/jantam13/victor-triage-lora-llama3.1-8b)
is a hackathon-scope fine-tune. Production V2 retraining would expand
the corpus beyond the current 50k MIMIC-IV CVD cases, add held-out
evaluation against a balanced demographic test set with reported
sensitivity/specificity per subgroup, and publish a model card with
intended-use scope, known failure modes, and refresh cadence.

---

## License

MIT.
