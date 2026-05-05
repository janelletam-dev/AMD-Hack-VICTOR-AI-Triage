"""5-agent swarm — shared singleton.

All agents share one VLLMService (one LangChain ChatOpenAI client) so
they hit the same OpenAI-compatible endpoint with different system
prompts. The endpoint is Ollama locally (default) or vLLM on MI300X
(set VLLM_BASE_URL).

Usage:
    from agents import swarm
    await swarm.victor.on_concordance_evaluation(room, flags, transcript, ...)
    text = await swarm.jackie.respond(transcript, language)
    report = await swarm.elmer.synthesize(session_log)
"""
from __future__ import annotations

from agents.elmer_agent import ElmerAgent
from agents.jackie_agent import JackieAgent
from agents.merced_agent import MercedAgent
from agents.scribe_agent import ScribeAgent
from agents.victor_agent import VictorAgent
from services.vllm_service import VLLMService


class Swarm:
    """Holds one instance of each agent + the shared LLM client."""

    def __init__(self) -> None:
        self.llm = VLLMService()
        # Sub-agents are stateless wrt session (S.C.R.I.B.E. carries note state
        # for now — a multi-room build would key it on room_id).
        self.merced = MercedAgent(self.llm)
        self.jackie = JackieAgent(self.llm)
        self.scribe = ScribeAgent(self.llm)
        self.elmer = ElmerAgent(self.llm)
        self.victor = VictorAgent(
            self.llm,
            merced=self.merced,
            scribe=self.scribe,
            jackie=self.jackie,
        )


swarm = Swarm()
