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

_FALLBACK_ESCALATED = (
    "I just want to make sure I have the full picture. Have you had any "
    "pressure or tightness in your chest, jaw, or arm — even briefly?"
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

    async def respond(
        self,
        transcript: str,
        language: str = "en",
        escalated: bool = False,
    ) -> str:
        """Generate the next interviewer turn. Returns plain text for TTS.

        - `transcript`: most recent finalised utterance from the patient.
        - `language`: detected language code; reply in the same language.
        - `escalated`: True after V.I.C.T.O.R. has fired a concordance flag.
          Triggers the targeted-cardiac-symptom mode in the system prompt.

        On LLM failure, walks the OPQRST + SAMPLE coverage list in order so
        we still gather the right clinical ground deterministically.
        """
        if not transcript:
            return ""
        try:
            mode = "ESCALATED MODE — elicit cardiac symptoms" if escalated else "STANDARD MODE"
            user = (
                f"{mode}\n"
                f"Patient utterance ({language}): {transcript!r}\n"
                "\nGenerate ONE follow-up turn. Acknowledge briefly, then ask "
                "exactly one clinically relevant question. Reply in the same "
                "language as the patient. <30 words. No clinical jargon. "
                "If the patient said something off-topic, vague, frustrated, "
                "silent, or alarming, follow the EDGE-CASE HANDLING rules in "
                "the system prompt."
            )
            text = await self.llm.chat(
                [
                    ChatMessage(role="system", content=PROMPT),
                    ChatMessage(role="user", content=user),
                ],
                temperature=0.4,
                max_tokens=120,
                # JACKIE specifically uses the BASE model, not the LoRA fine-tune.
                # The fine-tune was trained on data with therapy-coded language
                # and consistently leaks phrasings like "I know you're trying to
                # help, but..." or "What's been on your mind" despite the system
                # prompt forbidding them. Base llama3.1:8b follows the prompt's
                # ED-triage register more cleanly. The LoRA stays active for
                # M.E.R.C.E.D. and the other agents where clinical register is
                # appropriate.
                model="llama3.1:8b",
            )
            text = text.strip().strip('"').strip()
            # Strip parenthetical "internal monologue" asides — the fine-tuned
            # model occasionally appends notes like "(I'm looking for more info
            # on the nausea.)" which ElevenLabs would read aloud verbatim. The
            # patient should hear only the actual question.
            text = re.sub(r"\s*\([^)]*\)\s*", " ", text).strip()
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
                return _FALLBACK_ESCALATED
            # Walk the OPQRST/SAMPLE coverage list in order on each call.
            idx = self._fallback_idx % len(_OPQRST_SAMPLE_FALLBACK)
            self._fallback_idx += 1
            return _OPQRST_SAMPLE_FALLBACK[idx]

    def reset_fallback_progress(self) -> None:
        """Reset the deterministic-fallback walker. Call between sessions."""
        self._fallback_idx = 0
