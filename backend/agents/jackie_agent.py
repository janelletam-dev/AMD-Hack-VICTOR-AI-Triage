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
from pathlib import Path

from services.vllm_service import ChatMessage, LLMUnavailable, VLLMService

log = logging.getLogger("victor.agent.jackie")

PROMPT = (Path(__file__).parent.parent / "prompts" / "jackie_system.txt").read_text()

# Conservative fallbacks if the LLM is offline. Better to say something
# warm and generic than to leave the patient in silence at the kiosk.
_FALLBACK_NEUTRAL = (
    "Thank you for sharing that. Can you tell me a bit more about how "
    "you're feeling right now?"
)
_FALLBACK_ESCALATED = (
    "I just want to make sure I have the full picture. Have you had any "
    "pressure or tightness in your chest, jaw, or arm — even briefly?"
)


class JackieAgent:
    name = "J.A.C.K.I.E."

    def __init__(self, llm: VLLMService) -> None:
        self.llm = llm

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
                "language as the patient. <30 words. No clinical jargon."
            )
            text = await self.llm.chat(
                [
                    ChatMessage(role="system", content=PROMPT),
                    ChatMessage(role="user", content=user),
                ],
                temperature=0.4,
                max_tokens=120,
            )
            text = text.strip().strip('"').strip()
            if not text:
                raise ValueError("empty LLM response")
            return text
        except (LLMUnavailable, ValueError) as e:
            log.info("jackie fallback (LLM unavailable): %s", e)
            return _FALLBACK_ESCALATED if escalated else _FALLBACK_NEUTRAL
