# V.I.C.T.O.R. — 5-MINUTE DEMO SCRIPT

> Print this. Bring it on stage. Don't ad-lib the stats.
> Total: **5:00** (4:30 of content + 0:30 buffer)

---

## PRE-FLIGHT (run 5 min before going on stage)

- [ ] **DEMO_MODE=true** in `/victor/.env` (Thymia bypass — guarantees the concordance flag)
- [ ] Backend running. `curl localhost:8000/health/full | jq .summary`
      → expect `{"ok": 4, ...}`. If LLM not green, run `ollama serve` in another terminal
- [ ] Ollama: `ollama list` → confirm `llama3.1:8b` present
- [ ] Open **two** Chrome windows (NOT Safari — better mic permissions):
      - Window 1: `http://localhost:8000/patient` (kiosk)
      - Window 2: `http://localhost:8000/clinician` (dashboard, **no `?dev=1`**)
- [ ] Test the mic: click Begin → Jackie → tap mic → say "test" → see "test" appear
      in transcript. If it doesn't, fix it BEFORE going on. Do not try to fix it on stage.
- [ ] Backup MP4 demo recording open in a hidden tab as Plan Z
- [ ] Laptop volume at ~60% so Jackie's TTS is audible but doesn't dominate

---

## OPENING — 0:00 → 0:30

**Screen:** Landing page (`/`)

> *"Every year in U.S. emergency rooms, women presenting with cardiovascular*
> *symptoms get under-triaged compared to men with the same condition. The*
> *reason isn't a knowledge gap — it's a language gap. Women minimise.*
> *They say 'my stomach hurts,' not 'I'm having a heart attack.' We pulled*
> *50,000 cardiovascular cases from MIMIC-IV and confirmed it: female CVD*
> *patients with abdominal pain average an acuity score of 2.85 — meaning*
> *they get pushed to the back of the queue. V.I.C.T.O.R. catches that*
> *mismatch in real time."*

**Click:** "Begin"

---

## PHASE 1 — THE KIOSK (PATIENT) — 0:30 → 2:00

**Screen:** `/patient` voice selector

> *"This is the kiosk a patient sees in the waiting area. Jackie is the*
> *voice they talk to."*

**Click:** Jackie

> *"Speech-to-text is Deepgram Flux Multilingual — patient can speak in*
> *English, Spanish, French, German, Portuguese, Hindi, Italian, or Thai*
> *and the system code-switches mid-sentence. Voice synthesis is*
> *ElevenLabs."*

### Step 1 — Name (15s)
**Tap mic. Say:** "Hi, my name is Maria Hernandez."
**Tap mic to stop. Confirm card appears → tap "Yes, that's correct"**

### Step 2 — DOB (15s)
**Tap mic. Say:** "January fifteenth, nineteen seventy-two."
**Tap mic to stop. Confirm → "Yes, that's correct"**

### Step 3 — The minimisation line (40s)
**Tap mic. Say (DELIBERATELY, slightly tired tone):**

> *"My stomach really hurts and I've been feeling nauseous, but it's*
> *probably just something I ate."*

**Tap mic to stop. Click "Continue — follow-up questions"**

### Step 4 — Jackie's adaptive follow-up (20s)

J.A.C.K.I.E. asks one or two questions. Whatever she asks, give a brief, calm answer. Suggested:

- *"When did this start?"* → **"Maybe two hours ago, after lunch."**
- *"On a scale of 1 to 10?"* → **"Probably a 6, sometimes a 7."**
- *"Does the pain go anywhere else?"* → **"Just my stomach. Maybe my chest a little, but I'm sure that's nothing."**

> *That last line is gold — voluntary chest mention layered on the minimisation
> phrase. Don't force it; only say it if Jackie asks about radiation.*

**TALKING POINT (while answers are happening):**

> *"Notice she's not screaming. She's not in distress on the surface. A*
> *typical text-based triage tool would put her at ESI 3 — non-urgent.*
> *Watch what V.I.C.T.O.R. does."*

---

## PHASE 2 — THE DASHBOARD (CLINICIAN) — 2:00 → 3:45

**Switch to Window 2:** `/clinician`

The events flow live as the patient phase advances. Within ~3 seconds you should see:

- 🔴 **M.E.R.C.E.D. AI OVERRIDE banner** at top with confidence ~94%
- **Voice Biomarkers populate:** stress 0.66, distress 0.66, mental strain 0.68 (Thymia Helios)
- **ESI: 3 → 2** with reason "Tier 1 concordance flag"
- **SOAP note auto-populates** (Subjective/Objective/Assessment/Plan)
- **Live transcript** showing the patient's words verbatim
- **5-Agent Swarm panel** showing each agent's activity in real time

**TALKING POINT (let the screen update for ~3 seconds, then):**

> *"Five things just happened in three seconds:*
>
> *One — Deepgram transcribed her in real time.*
>
> *Two — Thymia's voice biomarkers detected elevated stress and distress*
> *that don't match her words. We call that the concordance gap.*
>
> *Three — M.E.R.C.E.D., our concordance engine, fired a Tier 1 flag,*
> *citing MIMIC-IV evidence: 'abdominal pain in female CVD cohort,*
> *mean acuity 2.85, under-triaged in 30% of cases.'*
>
> *Four — V.I.C.T.O.R., the orchestrator, escalated her ESI from 3 to 2.*
> *That's the difference between 'wait two hours' and 'see a clinician now.'*
>
> *Five — S.C.R.I.B.E. drafted her SOAP note while we were talking. The*
> *clinician opens this and 80% of their charting is already done."*

**Hover over the M.E.R.C.E.D. banner.**

> *"Every flag shows confidence and the evidence basis. Nothing happens*
> *without a citation. This isn't a black box."*

---

## PHASE 3 — THE EVIDENCE REPORT — 3:45 → 4:30

**Click:** "Sign & Save" → routes to `/clinician/epic` (Epic-style EMR view)

> *"This is the EMR view. Same patient. Now we hit the AMD MI300X."*

**Click:** "Sign & Save → Generate Report" → routes to `/clinician/report`

E.L.M.E.R. synthesises the report via the LLM. Takes ~10-15 seconds on Ollama, near-instant on the MI300X via vLLM.

**TALKING POINT (while it loads):**

> *"E.L.M.E.R. — our evidence-retrieval agent — runs on a fine-tuned LLM*
> *deployed on a DigitalOcean GPU droplet, AMD MI300X. It synthesises*
> *the full triage encounter into a single auditable record: every signal*
> *cited, every escalation justified, full transcript attached."*

**Report renders. Scroll to the bottom briefly.**

> *"This is what gets pushed to the chart. Every clinical decision*
> *V.I.C.T.O.R. made, with the evidence behind it. If a clinician*
> *overrides our recommendation, that's logged too. The whole thing*
> *is auditable end to end."*

---

## CLOSING — 4:30 → 5:00

**Switch back to dashboard or land on the report. Look up.**

> *"V.I.C.T.O.R. — Voice-first Intelligent Clinical Triage Orchestrator.*
> *Five agents, voice-first, bias-aware. Built on AMD MI300X via*
> *DigitalOcean. Voice biomarkers from Thymia. Real-time STT from*
> *Deepgram. Voice synthesis from ElevenLabs.*
>
> *We're saving the 30% of patients who get missed because they didn't*
> *sound sick enough. Thank you."*

---

## IF SOMETHING BREAKS

| Symptom | Action | Recovery time |
|---|---|---|
| Mic permission denied in browser | Use text-input fallback (visible under mic error) | <10s |
| Voice not transcribing | Speak louder, lean closer; system shows "It's quite loud here" prompt | 5s |
| Concordance flag doesn't fire | Verify DEMO_MODE=true. Worst case: switch to `/clinician?dev=1`, click Run Demo | 15s |
| LLM slow / E.L.M.E.R. hangs | Narrate while it loads. Deterministic fallback fires after timeout | n/a |
| WebSocket disconnects | Auto-reconnects with exponential backoff. Just keep talking | <5s |
| Backend totally dead | Plan Z: switch to backup MP4 in hidden tab | 5s |
| Patient says wrong demo line | Jackie will probe; redirect via her follow-up question | n/a |

**Golden rule:** if anything looks weird, **keep talking**. Don't go silent. The screen recovers faster than your audience's attention does.

---

## KEY STATS YOU NEED TO LAND

Memorise these. They're the credibility anchors:

- **30%** — under-triage rate for women with CVD presenting atypically
- **2.85** — MIMIC-IV mean ESI for abdominal pain in female CVD cohort
- **50,000** — CVD cases analysed in MIMIC-IV v3.1
- **5 agents** — J.A.C.K.I.E., V.I.C.T.O.R., M.E.R.C.E.D., S.C.R.I.B.E., E.L.M.E.R.
- **<3 seconds** — from patient utterance to clinician dashboard alert

---

## SPONSOR NAMES (drop at least once each)

- **DigitalOcean** — hosting the MI300X GPU droplet for vLLM
- **AMD** — MI300X is their flagship inference chip
- **Thymia** — voice biomarkers (Helios mental wellness model)
- **Deepgram** — Flux multilingual real-time STT
- **ElevenLabs** — Flash v2.5 voice synthesis (Victor + Jackie)
