"""GET /health/full — concurrent diagnostics across every external service.

Pings Deepgram, thymia Helios, ElevenLabs, and the OpenAI-compatible LLM
endpoint (Ollama or vLLM). Returns a status table so misconfiguration is
visible at a glance instead of surfacing as cryptic runtime errors.

Each check:
  - is non-blocking (parallel via asyncio.gather)
  - has a tight timeout so a slow service can't hang the response
  - degrades to a clear `unconfigured` status rather than failing the request
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
from fastapi import APIRouter

from config import settings

router = APIRouter(tags=["health"])

CHECK_TIMEOUT_S = 5.0


async def _ping(
    name: str,
    *,
    url: str | None,
    headers: dict[str, str] | None = None,
    method: str = "GET",
    configured: bool,
    expected_status: tuple[int, ...] = (200,),
) -> dict[str, Any]:
    if not configured:
        return {
            "service": name,
            "status": "unconfigured",
            "detail": "API key / base URL not set in environment",
            "latency_ms": None,
        }
    if not url:
        return {
            "service": name,
            "status": "error",
            "detail": "no probe URL configured",
            "latency_ms": None,
        }

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=CHECK_TIMEOUT_S) as client:
            r = await client.request(method, url, headers=headers or {})
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
    except httpx.TimeoutException:
        return {
            "service": name,
            "status": "timeout",
            "detail": f"no response within {CHECK_TIMEOUT_S}s",
            "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
        }
    except httpx.HTTPError as e:
        return {
            "service": name,
            "status": "unreachable",
            "detail": f"{type(e).__name__}: {e}",
            "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
        }

    if r.status_code in expected_status:
        return {
            "service": name,
            "status": "ok",
            "detail": f"HTTP {r.status_code}",
            "latency_ms": elapsed_ms,
        }
    if r.status_code in (401, 403):
        return {
            "service": name,
            "status": "auth_failed",
            "detail": f"HTTP {r.status_code} — credentials rejected",
            "latency_ms": elapsed_ms,
        }
    return {
        "service": name,
        "status": "degraded",
        "detail": f"HTTP {r.status_code}",
        "latency_ms": elapsed_ms,
    }


async def _check_deepgram() -> dict[str, Any]:
    # /v1/projects requires a valid token but is cheap and read-only.
    return await _ping(
        "deepgram",
        url="https://api.deepgram.com/v1/projects",
        headers={"Authorization": f"Token {settings.deepgram_api_key}"},
        configured=bool(settings.deepgram_api_key),
    )


async def _check_thymia() -> dict[str, Any]:
    # The OpenAPI spec is public and confirms the host is reachable.
    # Auth is only validated by hitting a model endpoint (which would create
    # billable runs), so we keep the probe to host reachability + key presence.
    result = await _ping(
        "thymia",
        url="https://api.thymia.ai/openapi.json",
        configured=bool(settings.thymia_api_key),
    )
    if result["status"] == "ok":
        result["detail"] = "host reachable; key presence not verified"
    return result


async def _check_elevenlabs() -> dict[str, Any]:
    # /v1/voices works with TTS-scoped keys; /v1/user requires user-read scope
    # which TTS-only keys lack (caused false 401s in earlier probes).
    return await _ping(
        "elevenlabs",
        url="https://api.elevenlabs.io/v1/voices",
        headers={"xi-api-key": settings.elevenlabs_api_key},
        configured=bool(settings.elevenlabs_api_key),
    )


async def _check_llm() -> dict[str, Any]:
    base = (settings.vllm_base_url or "").rstrip("/")
    headers: dict[str, str] = {}
    if settings.vllm_api_key:
        headers["Authorization"] = f"Bearer {settings.vllm_api_key}"
    # OpenAI-compatible servers (vLLM and Ollama's /v1) all expose /models.
    result = await _ping(
        "llm",
        url=f"{base}/models" if base else None,
        headers=headers,
        configured=bool(base),
    )
    result["detail"] = (
        f"{result.get('detail', '')} · model={settings.vllm_model} · base={base}"
    ).strip(" ·")
    return result


@router.get("/health/services")
async def health_services() -> dict[str, Any]:
    """Lightweight service status for the frontend AI-mode banner."""
    checks = await asyncio.gather(
        _check_llm(),
        _check_deepgram(),
        _check_elevenlabs(),
        _check_thymia(),
        return_exceptions=False,
    )
    llm_status = checks[0]
    llm_ok = llm_status["status"] == "ok"
    return {
        "llm": {"available": llm_ok, "endpoint": (settings.vllm_base_url or "").rstrip("/")},
        "deepgram": {"available": checks[1]["status"] == "ok"},
        "elevenlabs": {"available": checks[2]["status"] == "ok"},
        "thymia": {"available": checks[3]["status"] == "ok"},
        "mode": "ai-assisted" if llm_ok else "deterministic-fallback",
        "demo_mode": settings.demo_mode,
    }


@router.get("/health/full")
async def health_full() -> dict[str, Any]:
    checks = await asyncio.gather(
        _check_deepgram(),
        _check_thymia(),
        _check_elevenlabs(),
        _check_llm(),
        return_exceptions=False,
    )

    summary = {
        "ok": sum(1 for c in checks if c["status"] == "ok"),
        "degraded": sum(1 for c in checks if c["status"] in ("degraded", "auth_failed")),
        "unreachable": sum(1 for c in checks if c["status"] in ("unreachable", "timeout")),
        "unconfigured": sum(1 for c in checks if c["status"] == "unconfigured"),
        "total": len(checks),
    }
    overall = (
        "ok" if summary["ok"] == summary["total"]
        else "degraded" if summary["unreachable"] == 0 and summary["unconfigured"] == 0
        else "incomplete"
    )

    return {
        "overall": overall,
        "summary": summary,
        "checks": checks,
        "env": settings.node_env,
    }
