"""V.I.C.T.O.R. — FastAPI app entry.

Day 1 scope: WebSocket audio ingest skeleton + transcript fan-out.
Later days wire in Thymia, the concordance engine, the swarm, and TTS.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from routers import audio_ws, reports, tts

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("victor")

app = FastAPI(
    title="V.I.C.T.O.R.",
    description="Voice-first AI triage agent — backend.",
    version="0.1.0",
)

# Frontend dev server + Railway deployments. Tighten in production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(audio_ws.router)
app.include_router(reports.router)
app.include_router(tts.router)


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "victor",
        "version": app.version,
        "env": settings.node_env,
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.on_event("startup")
async def _startup() -> None:
    log.info("V.I.C.T.O.R. backend starting (env=%s)", settings.node_env)
    log.info(
        "Audio config: %d Hz, %d samples/frame (%d bytes)",
        settings.sample_rate_hz,
        settings.frame_samples,
        settings.frame_bytes,
    )


@app.on_event("shutdown")
async def _shutdown() -> None:
    log.info("V.I.C.T.O.R. backend shutting down")
