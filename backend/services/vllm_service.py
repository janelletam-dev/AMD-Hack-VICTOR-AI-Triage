"""vLLM client for Llama 3 8B on AMD MI300X.

Day 3 — single OpenAI-compatible HTTP endpoint, shared by all 5 agents.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from config import settings

log = logging.getLogger("victor.vllm")


@dataclass
class ChatMessage:
    role: str
    content: str


class VLLMService:
    def __init__(self) -> None:
        self.base_url = settings.vllm_base_url.rstrip("/")
        self._client: httpx.AsyncClient | None = None

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=30.0)
        return self._client

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.2,
        max_tokens: int = 512,
        model: str = "meta-llama/Meta-Llama-3-8B-Instruct",
    ) -> str:
        """Single non-streaming completion. Streaming variant comes Day 3."""
        # TODO(Day 3): implement once vLLM endpoint is live on MI300X.
        # Skeleton call shape:
        # client = await self._http()
        # r = await client.post(
        #     f"{self.base_url}/chat/completions",
        #     json={
        #         "model": model,
        #         "messages": [m.__dict__ for m in messages],
        #         "temperature": temperature,
        #         "max_tokens": max_tokens,
        #     },
        # )
        # r.raise_for_status()
        # return r.json()["choices"][0]["message"]["content"]
        return ""

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
