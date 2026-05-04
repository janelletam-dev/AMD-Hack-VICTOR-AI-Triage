"""E.L.M.E.R. — Evidence Synthesiser.

Day 4 — end-of-triage comprehensive report. Triggered on demand by
the clinician (POST /api/report), not on the hot path.

Latency target: <5s.
"""
from __future__ import annotations

from pathlib import Path

from services.vllm_service import VLLMService

PROMPT = (Path(__file__).parent.parent / "prompts" / "elmer_system.txt").read_text()


class ElmerAgent:
    name = "E.L.M.E.R."

    def __init__(self, llm: VLLMService) -> None:
        self.llm = llm

    async def synthesize(self, session_log: dict) -> dict:
        """Return the full evidence report for a completed triage session."""
        # TODO(Day 4): implement
        return {}
