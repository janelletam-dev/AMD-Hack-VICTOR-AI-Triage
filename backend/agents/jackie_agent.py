"""J.A.C.K.I.E. — Patient Voice (conversational interviewer).

Day 4 — asks clinically relevant follow-ups in the patient's language.
Shifts to targeted cardiac symptom elicitation when V.I.C.T.O.R. escalates.

Latency target: <1s per response.
"""
from __future__ import annotations

from pathlib import Path

from services.vllm_service import VLLMService

PROMPT = (Path(__file__).parent.parent / "prompts" / "jackie_system.txt").read_text()


class JackieAgent:
    name = "J.A.C.K.I.E."

    def __init__(self, llm: VLLMService) -> None:
        self.llm = llm

    async def respond(self, transcript: str, language: str, escalated: bool) -> str:
        """Generate the next interviewer turn. Returns plain text for TTS."""
        # TODO(Day 4): implement
        return ""
