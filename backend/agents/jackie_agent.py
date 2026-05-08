"""J.A.C.K.I.E. — Patient Voice (conversational interviewer).

Generates the next conversational turn for the patient kiosk. The output
is plain text, fed to ElevenLabs for TTS playback.

Identity verification (name + DOB) is handled deterministically in the
frontend before J.A.C.K.I.E. takes over. This agent owns the clinical
follow-up loop after the chief-complaint phase.

Latency budget: <1s per response.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

from config import settings
from services.vllm_service import ChatMessage, LLMUnavailable, VLLMService

log = logging.getLogger("victor.agent.jackie")

PROMPT = (Path(__file__).parent.parent / "prompts" / "jackie_system.txt").read_text()

# Deterministic fallback turns. Used when the LLM is offline; iterates through
# the OPQRST + SAMPLE coverage list in order so we still cover the right
# clinical ground. The agent rotates through these on successive calls.
_OPQRST_SAMPLE_FALLBACK: tuple[str, ...] = (
    # Onset
    "Thank you for sharing that. When did this first start?",
    # Severity
    "On a scale where 1 is mild and 10 is the worst pain you've ever felt, "
    "how would you rate it right now?",
    # Quality + Radiation
    "Can you describe what it feels like? And does it move anywhere else — "
    "your back, jaw, arm, or shoulder?",
    # Past medical history
    "Do you have any existing health conditions — things like diabetes, "
    "high blood pressure, or heart problems?",
    # Medications
    "Are you taking any medications right now?",
    # Allergies
    "Any allergies we should know about, especially to medications?",
    # Final coverage prompt
    "Is there anything else you've been feeling, even if you think it's "
    "unrelated?",
)

# Escalated-mode deterministic fallback. Used when the LLM is offline AND
# V.I.C.T.O.R. has already fired a concordance flag — JACKIE switches into
# targeted cardiac elicitation per the system prompt's ESCALATED MODE
# section. Bug surfaced 2026-05-07 on the Stage 1 Railway deploy: previously
# this was a SINGLE string, so once a session escalated every JACKIE
# fallback turn looped the same cardiac probe regardless of patient answer.
# Now rotates through cardiac-focused coverage in clinical priority order.
_FALLBACK_ESCALATED: tuple[str, ...] = (
    "I just want to make sure I have the full picture. Have you had any "
    "pressure or tightness in your chest, jaw, or arm — even briefly?",
    "Did you have any sweating, nausea, or shortness of breath alongside "
    "the pain?",
    "Did this come on suddenly, or did it build up gradually?",
    "Was it worse when you were active — walking, climbing stairs — or "
    "did it happen even at rest?",
    "Have you ever had a heart attack, stent, or bypass before? Anyone in "
    "your family had a heart attack at a young age?",
    "Do you smoke, or have high blood pressure, diabetes, or high "
    "cholesterol?",
    "Is there anything else you've been feeling — even something that "
    "seems unrelated — that I should know about?",
)


class JackieAgent:
    name = "J.A.C.K.I.E."

    def __init__(self, llm: VLLMService) -> None:
        self.llm = llm
        # Track the OPQRST/SAMPLE step we'd ask next IF the LLM fails. The
        # backend re-instantiates a Swarm singleton per process so this state
        # is process-scoped (single-room demo). Multi-room would key it on
        # session_id; not worth the complexity for the hackathon.
        self._fallback_idx = 0
        # Separate walker for escalated-mode fallback so the cardiac probe
        # list advances independently of the standard OPQRST/SAMPLE walker.
        self._fallback_idx_escalated = 0

    async def respond(
        self,
        transcript: str,
        language: str = "en",
        escalated: bool = False,
        history: list[dict] | None = None,
        chief_complaint: str | None = None,
        coverage_covered: set[str] | None = None,
        coverage_remaining: list[str] | None = None,
        facts_block: str | None = None,
    ) -> str:
        """Generate the next interviewer turn. Returns plain text for TTS.

        - `transcript`: most recent finalised utterance from the patient.
        - `language`: detected language code; reply in the same language.
        - `escalated`: True after V.I.C.T.O.R. has fired a concordance flag.
          Triggers the targeted-cardiac-symptom mode in the system prompt.
        - `history`: prior turns as a list of {"role": "patient" | "jackie",
          "text": "..."}. Without this J.A.C.K.I.E. has amnesia and asks
          questions she's already asked (the patient says "24 hours ago"
          and the next turn is "when did it start — yesterday? today?").
        - `chief_complaint`: full text the patient typed/said in the
          complaint phase, used as the seed turn so J.A.C.K.I.E.
          starts with context, not a cold question.

        On LLM failure, walks the OPQRST + SAMPLE coverage list in order so
        we still gather the right clinical ground deterministically.
        """
        if not transcript:
            return ""
        try:
            mode = "ESCALATED MODE — elicit cardiac symptoms" if escalated else "STANDARD MODE"
            # Build a chat-style history so the LLM has full conversational
            # context. Order:
            #   1. system prompt (clinical persona + rules)
            #   2. seed: chief complaint (as a "patient" turn)
            #   3. prior turns from `history` (alternating patient/jackie)
            #   4. the current utterance + instruction to answer
            messages: list[ChatMessage] = [ChatMessage(role="system", content=PROMPT)]
            if chief_complaint and chief_complaint.strip():
                messages.append(ChatMessage(
                    role="user",
                    content=f"[Chief complaint, captured at intake]: {chief_complaint.strip()}",
                ))
            for h in (history or []):
                role = h.get("role")
                text = (h.get("text") or "").strip()
                if not text:
                    continue
                if role == "jackie":
                    messages.append(ChatMessage(role="assistant", content=text))
                elif role == "patient":
                    messages.append(ChatMessage(role="user", content=text))
            # Coverage hint — server-side regex tracker tells the LLM
            # exactly which OPQRST/SAMPLE elements the patient has
            # already mentioned (across all prior turns) and which
            # element to ask about next. Without this the LLM was
            # relying purely on its own conversational coherence and
            # kept re-asking onset / severity that the patient already
            # answered. Priority order is biased by chief complaint
            # (cardiac front-loads radiation + associated; abdominal
            # inserts LMP for female-bodied; headache front-loads
            # severity + associated neuro). See coverage_tracker.py.
            coverage_block = ""
            if coverage_covered or coverage_remaining:
                covered_disp = sorted(coverage_covered) if coverage_covered else []
                remaining_disp = (coverage_remaining or [])[:4]
                coverage_block = (
                    f"\n\nCOVERAGE SO FAR: {covered_disp or ['nothing yet']}\n"
                    f"NEXT PRIORITIES (pick ONE, usually the first): "
                    f"{remaining_disp or ['triage complete — close warmly']}\n"
                    "STRICT: Do NOT ask about anything in COVERAGE SO FAR. "
                    "The patient already gave you that information. "
                    "Re-asking makes the kiosk look broken.\n"
                )
            # Final turn: the patient's most recent utterance + the
            # instruction to compose the next question. Keeping the
            # instruction here (rather than baked into the system
            # prompt) lets us tweak per-turn behaviour like ESCALATED
            # mode without changing the system prompt mid-stream.
            facts_section = f"\n\n{facts_block}\n" if facts_block else ""
            user = (
                f"{mode}{coverage_block}{facts_section}\n"
                f"Patient just said ({language}): {transcript!r}\n\n"
                "Generate ONE follow-up turn. Acknowledge briefly if the "
                "patient revealed something new, then ask exactly ONE "
                "clinically relevant question THAT HAS NOT ALREADY BEEN "
                "ASKED OR ANSWERED in the conversation above. Pick from "
                "NEXT PRIORITIES if a coverage block was provided. "
                "Respect PATIENT-DISCLOSED FACTS verbatim — do not change "
                "family member, age, outcome, or duration. "
                "Reply in the same language as the patient. <30 words. "
                "No clinical jargon. Follow the EDGE-CASE HANDLING rules "
                "in the system prompt for off-topic, vague, frustrated, "
                "silent, or alarming inputs."
            )
            messages.append(ChatMessage(role="user", content=user))
            text = await self.llm.chat(
                messages,
                temperature=0.4,
                # JACKIE turns are constrained to <30 words by prompt
                # (~45 tokens). Cap max_tokens at 80 — gives headroom
                # for occasional 2-sentence acknowledgement+question
                # turns while preventing runaway generations from
                # blowing the voice-to-voice latency budget. Was 120;
                # measured ~50ms saved on the 95th percentile.
                max_tokens=80,
                # JACKIE prefers the BASE model (no LoRA) when one is exposed
                # — the fine-tune leaks therapy-coded phrasings ("I know you're
                # trying to help, but…", "What's been on your mind") despite
                # the system prompt forbidding them. Base llama follows the
                # ED-triage register more cleanly. Configurable via
                # VLLM_BASE_MODEL — falls through to VLLM_MODEL when the
                # droplet only exposes the LoRA name (default vLLM setup).
                model=settings.vllm_base_model,
            )
            text = text.strip().strip('"').strip()
            # Strip metacommentary the LLM sometimes wraps around its
            # actual question — observed in testing:
            #   Here's a follow-up turn: "Okay, so it started before...?"
            #   This response acknowledges the patient's new information
            #   and asks a clinically relevant question that has not been
            #   asked or answered yet.
            # The patient hears EVERYTHING the LLM emits via TTS, so any
            # explanation about WHY the question was chosen leaks aloud.
            # Two-step extraction:
            #   1. If the LLM wrapped its question in straight quotes, pull
            #      the FIRST quoted segment out and use that as the response.
            #   2. Otherwise, strip "Here's [a/the] [follow-up/next/...] :"
            #      style prefixes and any trailing commentary that starts
            #      with "This response/question/message..." or "I'm asking..."
            quoted_match = re.search(r'"([^"]{8,400}\?)"', text)
            if quoted_match:
                text = quoted_match.group(1).strip()
            else:
                text = re.sub(
                    r"^(here'?s|this is)\s+(a|the|my|your)?\s*"
                    r"(follow[-\s]up|next|response|question|reply|turn)"
                    r"[^.?!]{0,40}[:.]\s*",
                    "",
                    text,
                    flags=re.IGNORECASE,
                ).strip()
                text = re.sub(
                    r"\.?\s*(this\s+(response|question|message|turn|reply)|"
                    r"i'?m\s+asking|i\s+asked|the\s+goal\s+is)\s+"
                    r"(acknowledges?|asks?|seeks?|aims?|covers?|addresses?|"
                    r"is\s+(designed|meant|intended)|focuses)[^.]*\.?\s*$",
                    "",
                    text,
                    flags=re.IGNORECASE,
                ).strip().strip('"').strip()
            # Strip parenthetical "internal monologue" asides — the fine-tuned
            # model occasionally appends notes like "(I'm looking for more info
            # on the nausea.)" which ElevenLabs would read aloud verbatim. The
            # patient should hear only the actual question.
            text = re.sub(r"\s*\([^)]*\)\s*", " ", text).strip()
            # Also strip square-bracket asides — same problem class as parens
            # ("[Acknowledgement: ...]", "[Reasoning: ...]") that some
            # instruction-tuned models emit alongside or instead of parens.
            text = re.sub(r"\s*\[[^\]]*\]\s*", " ", text).strip()
            # Strip imperative meta-instructions where the LLM narrates what
            # it SHOULD do rather than doing it. Live-test surfaced one
            # instance where TTS read aloud:
            #   "...acknowledge and ask her this question..."
            # Pattern: optional "Let me / I'll / I should / I will / I need to
            # / I want to" prefix → "acknowledge" → optional "and ask
            # her/him/them/the patient ..." → terminator (:, ., ?, !).
            # Strips at start-of-text only so legitimate "I'll ask" phrasings
            # mid-sentence (rare but possible) aren't caught by accident.
            text = re.sub(
                r"^\s*(?:let\s+me\s+|i'?ll\s+|i\s+(?:will|should|need\s+to|want\s+to|am\s+going\s+to)\s+)?"
                r"acknowledge\b[^?!]{0,200}?"
                r"(?:and\s+(?:then\s+)?ask\s+(?:her|him|them|the\s+patient)?[^?!]{0,150}?)?"
                r"[:.?]\s*",
                "",
                text,
                flags=re.IGNORECASE,
            ).strip()
            # Mirror pattern: turn starts with "Ask her/him/them/the patient"
            # in third-person — JACKIE always speaks to the patient in second
            # person ("you/your"), so a third-person imperative at start of a
            # turn is meta-instruction by definition.
            text = re.sub(
                r"^\s*(?:let\s+me\s+|i'?ll\s+|i\s+(?:will|should|need\s+to|want\s+to|am\s+going\s+to)\s+)?"
                r"ask\s+(?:her|him|them|the\s+patient)\b[^?!]{0,150}?[:.?]\s*",
                "",
                text,
                flags=re.IGNORECASE,
            ).strip()
            # Defensive post-filter: strip the most common therapy-coded
            # opener that the fine-tune still emits even on the base model
            # if the system prompt doesn't quite override it. Catches
            # "I know you're trying to help, but…" and similar
            # patronising redirects.
            text = re.sub(
                r"^(I (know|hear|understand)( that)?( you('?re| are))?[^.?!]*[,.]\s*)+",
                "",
                text,
                flags=re.IGNORECASE,
            ).strip()
            # Also strip "Thank(s) for sharing…" and "Thanks for telling
            # me…" leads — these surfaced in testing when J.A.C.K.I.E.
            # was given only the last utterance as a seed and reverted
            # to a generic empathy preamble. The seed-fix in audio_ws
            # is the upstream cure; this is belt-and-suspenders.
            text = re.sub(
                r"^(thanks?\s+(you\s+)?(for\s+)?(sharing|telling\s+me|letting\s+me\s+know)[^.?!]*[,.]\s*)+",
                "",
                text,
                flags=re.IGNORECASE,
            ).strip()
            # Strip the chief-complaint re-ask that J.A.C.K.I.E. falls
            # back to when she has no usable seed. The patient just
            # answered this question on the previous screen — repeating
            # it makes the kiosk look like it dropped their complaint.
            text = re.sub(
                r"\b(what'?s\s+been\s+on\s+your\s+mind|what\s+brought\s+you\s+(in|here)\s+today|what\s+brings\s+you\s+(in|here))[?.!]?\s*",
                "",
                text,
                flags=re.IGNORECASE,
            ).strip()
            # If the entire response was just the patronising opener, fall
            # back to the canned acknowledgement + question.
            if not text or len(text) < 10:
                raise ValueError("post-filter stripped response to nothing")
            if not text:
                raise ValueError("empty LLM response")
            return text
        except (LLMUnavailable, ValueError) as e:
            log.info("jackie fallback (LLM unavailable): %s", e)
            if escalated:
                # Walk the cardiac-focused escalated-mode list in order
                # rather than returning the same string every call (the
                # 2026-05-07 loop bug).
                idx = self._fallback_idx_escalated % len(_FALLBACK_ESCALATED)
                self._fallback_idx_escalated += 1
                return _FALLBACK_ESCALATED[idx]
            # Walk the OPQRST/SAMPLE coverage list in order on each call.
            idx = self._fallback_idx % len(_OPQRST_SAMPLE_FALLBACK)
            self._fallback_idx += 1
            return _OPQRST_SAMPLE_FALLBACK[idx]

    def reset_fallback_progress(self) -> None:
        """Reset both deterministic-fallback walkers. Call between sessions."""
        self._fallback_idx = 0
        self._fallback_idx_escalated = 0
