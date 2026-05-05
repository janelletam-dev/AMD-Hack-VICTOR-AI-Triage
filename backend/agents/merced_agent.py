"""M.E.R.C.E.D. — Concordance Analyst (silent bias detection).

Receives a structured concordance trigger from engine.concordance and
generates a one-sentence clinical gloss. Latency budget: <1s per flag.
"""
from __future__ import annotations

import logging
from pathlib import Path

from services.vllm_service import ChatMessage, LLMUnavailable, VLLMService

log = logging.getLogger("victor.agent.merced")

PROMPT = (Path(__file__).parent.parent / "prompts" / "merced_system.txt").read_text()


class MercedAgent:
    name = "M.E.R.C.E.D."

    def __init__(self, llm: VLLMService) -> None:
        self.llm = llm

    async def gloss(self, trigger: dict) -> str:
        """Return a one-sentence clinical gloss for a concordance trigger.

        Falls back to the engine's `gloss_seed` (deterministic, MIMIC-IV-grounded
        prose template) if the LLM is unreachable so the clinician dashboard
        always shows something legible.
        """
        seed = trigger.get("gloss_seed") or ""
        risk_factors = trigger.get("risk_factors") or []
        risk_aware = bool(trigger.get("risk_aware"))
        try:
            user = (
                "Concordance trigger:\n"
                f"  tier: {trigger.get('tier')}\n"
                f"  trigger_phrase: {trigger.get('trigger_phrase')!r}\n"
                f"  triage_label: {trigger.get('triage_label')!r}\n"
                f"  acuity: {trigger.get('acuity')}\n"
                f"  biomarker_signal: {trigger.get('biomarker_signal')!r}\n"
                f"  risk_factors: {risk_factors}\n"
                f"  risk_aware: {risk_aware}\n"
                f"  gloss_seed: {seed!r}\n"
                "\nWrite the single-sentence gloss exactly as specified in your "
                "system prompt. <40 words. Plain English. Expand abbreviations. "
                "If risk_factors is non-empty, mention them in the gloss."
            )
            text = await self.llm.chat(
                [
                    ChatMessage(role="system", content=PROMPT),
                    ChatMessage(role="user", content=user),
                ],
                temperature=0.2,
                max_tokens=140,
            )
            # Defensive: keep first non-empty line, in case the model preambles.
            for line in text.splitlines():
                line = line.strip()
                if line:
                    return line
            raise ValueError("empty LLM response")
        except (LLMUnavailable, ValueError) as e:
            log.info("merced fallback (using engine gloss_seed): %s", e)
            return seed or "Concordance flag — review recommended."
