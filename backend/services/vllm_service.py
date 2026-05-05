"""Shared LLM client for the 5-agent swarm.

The swarm targets either:
  - Ollama at http://localhost:11434/v1 (local stand-in while MI300X fine-tunes)
  - vLLM at http://<droplet-ip>:8000/v1 (production)

Both speak the OpenAI /v1/chat/completions format, so we use
`langchain_openai.ChatOpenAI` and configure it from env vars.
The agent instances all share one VLLMService — same endpoint,
different system prompts.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
)
from langchain_openai import ChatOpenAI

from config import settings

log = logging.getLogger("victor.vllm")


@dataclass
class ChatMessage:
    role: str           # "system" | "user" | "assistant"
    content: str


class LLMUnavailable(RuntimeError):
    """Raised when the LLM endpoint is unreachable. Callers may catch this
    to fall back to deterministic outputs (e.g. M.E.R.C.E.D.'s gloss seed,
    S.C.R.I.B.E.'s template SOAP) rather than dropping events entirely.
    """


def _to_lc(msgs: list[ChatMessage]) -> list[BaseMessage]:
    out: list[BaseMessage] = []
    for m in msgs:
        if m.role == "system":
            out.append(SystemMessage(content=m.content))
        elif m.role == "assistant":
            out.append(AIMessage(content=m.content))
        else:
            out.append(HumanMessage(content=m.content))
    return out


class VLLMService:
    """Async LangChain ChatOpenAI wrapper.

    All agents share one instance via the swarm singleton. Per-call kwargs
    (temperature, max_tokens, model override) are still allowed via .chat().
    """

    def __init__(self) -> None:
        self.base_url = settings.vllm_base_url.rstrip("/")
        self.default_model = settings.vllm_model
        self.api_key = settings.vllm_api_key

        # One reusable client. ChatOpenAI is cheap to construct, but reuse
        # avoids spinning up new httpx pools per call.
        self._client = ChatOpenAI(
            model=self.default_model,
            base_url=self.base_url,
            api_key=self.api_key,
            temperature=0.2,
            max_tokens=512,
            timeout=30,
        )
        log.info(
            "VLLMService configured: base_url=%s model=%s",
            self.base_url,
            self.default_model,
        )

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.2,
        max_tokens: int = 512,
        model: str | None = None,
    ) -> str:
        """Single non-streaming completion. Returns the assistant text.

        Re-binds the underlying ChatOpenAI per-call when model/temp/max_tokens
        differ from the defaults, otherwise reuses the pooled client.
        Raises LLMUnavailable if the endpoint can't be reached so callers
        can decide whether to fall back deterministically.
        """
        client = self._client
        if (
            (model and model != self.default_model)
            or temperature != 0.2
            or max_tokens != 512
        ):
            client = ChatOpenAI(
                model=model or self.default_model,
                base_url=self.base_url,
                api_key=self.api_key,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=30,
            )
        try:
            ai = await client.ainvoke(_to_lc(messages))
        except Exception as e:
            log.warning("LLM call failed (base_url=%s): %s", self.base_url, e)
            raise LLMUnavailable(str(e)) from e

        content = ai.content if isinstance(ai.content, str) else str(ai.content)
        return content.strip()

    async def aclose(self) -> None:  # kept for backwards-compat
        return None
