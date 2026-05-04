"""V.I.C.T.O.R. — Triage Leader (orchestrator).

Day 3 — routes audio, manages session state, makes escalation decisions
based on M.E.R.C.E.D. flags, adjusts ESI scores.

Latency target: <500ms decision routing.
"""
from __future__ import annotations

from pathlib import Path

from services.vllm_service import ChatMessage, VLLMService

PROMPT = (Path(__file__).parent.parent / "prompts" / "victor_system.txt").read_text()


class VictorAgent:
    name = "V.I.C.T.O.R."

    def __init__(self, llm: VLLMService) -> None:
        self.llm = llm

    async def decide(self, context: dict) -> dict:
        """Return {esi_standard, esi_adjusted, adjustment_reason} given the
        current session context (transcript, biomarkers, flags)."""
        # TODO(Day 3): implement
        return {}
