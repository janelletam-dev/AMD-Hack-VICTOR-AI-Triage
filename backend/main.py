"""V.I.C.T.O.R. — FastAPI app entry.

Day 1 scope: WebSocket audio ingest skeleton + transcript fan-out.
Later days wire in Thymia, the concordance engine, the swarm, and TTS.

Single-service deploy: FastAPI also serves the built React frontend out of
`frontend/dist/` (set via `VICTOR_FRONTEND_DIST` env var or auto-detected).
This means one URL for everything — kiosk, dashboard, API, WebSockets — and
no CORS preflight in production because frontend and backend are same-origin.
For local dev, run Vite separately on :5173 and the static mount is skipped
(no `dist/` exists).
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from config import settings
from routers import audio_ws, health, reports, tts

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

# CORS: comma-separated origins from VICTOR_ALLOWED_ORIGINS env var. Browsers
# reject `allow_origins=["*"]` + `allow_credentials=True`, so we never use
# wildcard. Default permits the local dev frontend; production must set the
# env var (e.g. "https://victor.example.com,https://kiosk.example.com").
_default_origins = "http://localhost:5173,http://127.0.0.1:5173"
_allowed_origins = [
    o.strip() for o in os.getenv("VICTOR_ALLOWED_ORIGINS", _default_origins).split(",")
    if o.strip()
]
log.info("CORS allowed_origins: %s", _allowed_origins)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(audio_ws.router)
app.include_router(health.router)
app.include_router(reports.router)
app.include_router(tts.router)


@app.get("/health")
def health_simple() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/info")
def service_info() -> dict[str, str]:
    """Service metadata. Moved off `/` so the SPA can be served at root."""
    return {"service": "victor", "version": app.version, "env": settings.node_env}


# ---------------------------------------------------------------------------
# Frontend static serving (single-service deploy)
# ---------------------------------------------------------------------------
# When `frontend/dist/` exists, mount it as the SPA. The catchall route at
# the bottom serves `index.html` for any unrecognised GET so client-side
# routing (e.g. `/clinician/epic`) works on hard reload.
#
# IMPORTANT: register all API routers and explicit `@app.get` handlers BEFORE
# this section. The `/{full_path:path}` catchall would shadow them otherwise.

_DIST_PATH = Path(
    os.getenv("VICTOR_FRONTEND_DIST")
    or (Path(__file__).resolve().parent.parent / "frontend" / "dist")
)

if _DIST_PATH.is_dir():
    log.info("serving frontend from %s", _DIST_PATH)
    # /assets/* — hashed JS + CSS bundles emitted by Vite. Mounted explicitly
    # so we get correct MIME types + long-cache headers via StaticFiles.
    _ASSETS = _DIST_PATH / "assets"
    if _ASSETS.is_dir():
        app.mount("/assets", StaticFiles(directory=_ASSETS), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_catchall(full_path: str) -> FileResponse:
        """Serve real files when they exist (favicon.svg etc.); fall back to
        index.html for SPA routes (`/patient`, `/clinician/epic`, …) so deep
        links and refresh work."""
        candidate = _DIST_PATH / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_DIST_PATH / "index.html")
else:
    log.info("frontend/dist not found — backend-only mode (Vite serves UI on :5173)")

    @app.get("/")
    def _dev_root() -> dict[str, str]:
        return {"service": "victor", "version": app.version, "env": settings.node_env}


@app.on_event("startup")
async def _startup() -> None:
    log.info("V.I.C.T.O.R. backend starting (env=%s)", settings.node_env)
    log.info(
        "Audio config: %d Hz, %d samples/frame (%d bytes)",
        settings.sample_rate_hz,
        settings.frame_samples,
        settings.frame_bytes,
    )
    # Production safety: loud warning if DEMO_MODE leaks to a production env.
    # The Thymia bypass + Run Demo button (if ?dev=1) are demo-only and
    # produce fabricated biomarker output that shouldn't appear in real triage.
    if settings.demo_mode and settings.node_env == "production":
        log.error(
            "⚠️  DEMO_MODE=true with NODE_ENV=production — Thymia output is "
            "scripted/fake. UNSET DEMO_MODE before serving real patients."
        )
    if settings.demo_mode:
        log.warning(
            "demo mode active: Thymia returns scripted biomarkers, no API call"
        )
    if "*" in os.getenv("VICTOR_ALLOWED_ORIGINS", ""):
        log.error("VICTOR_ALLOWED_ORIGINS contains '*' — invalid with credentials")


@app.on_event("shutdown")
async def _shutdown() -> None:
    log.info("V.I.C.T.O.R. backend shutting down")
