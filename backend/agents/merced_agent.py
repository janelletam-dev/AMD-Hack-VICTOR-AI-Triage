"""M.E.R.C.E.D. — Concordance Analyst (silent bias detection).

Day 3 — receives concordance triggers from engine.concordance, generates
one-sentence clinical gloss citing MIMIC-IV evidence.

Latency target: <1s per flag.
"""
from __future__ import annotations

from pathlib import Path

from services.vllm_service import VLLMService

PROMPT = (Path(__file__).parent.parent / "prompts" / "merced_system.txt").read_text()


class MercedAgent:
    name = "M.E.R.C.E.D."

    def __init__(self, llm: VLLMService) -> None:
        self.llm = llm

    async def gloss(self, trigger: dict) -> str:
        """Return a one-sentence clinical gloss for a concordance trigger."""
        # TODO(Day 3): implement
        return ""
