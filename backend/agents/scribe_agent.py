"""S.C.R.I.B.E. — Clinical Note Writer.

Day 3 — real-time SOAP note, updated on every utterance.
S=transcript, O=biomarkers, A=flags, P=V.I.C.T.O.R. recommendations.

Latency target: <2s note update per utterance.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from services.vllm_service import VLLMService

PROMPT = (Path(__file__).parent.parent / "prompts" / "scribe_system.txt").read_text()


@dataclass
class SOAPNote:
    subjective: str = ""
    objective: str = ""
    assessment: str = ""
    plan: str = ""


class ScribeAgent:
    name = "S.C.R.I.B.E."

    def __init__(self, llm: VLLMService) -> None:
        self.llm = llm
        self.note = SOAPNote()

    async def update(self, context: dict) -> SOAPNote:
        """Merge new context into the running SOAP note. Returns the full note."""
        # TODO(Day 3): implement
        return self.note
