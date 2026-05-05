# V.I.C.T.O.R. — multi-stage Docker build for Railway / generic container hosts.
# Used as a fallback to Nixpacks (see railway.json) when Nixpacks misbehaves;
# also handy for local container testing and any non-Railway deploys.
#
# Stage 1 builds the React frontend with Node 20.
# Stage 2 ships only the Python runtime + the static `dist/` it produced.
# No node_modules in the final image.

# =============================================================================
# Stage 1: build the frontend
# =============================================================================
FROM node:20-alpine AS frontend

WORKDIR /app/frontend

# Install deps with the lockfile for reproducible builds. `npm ci` is faster
# and stricter than `npm install` for CI-style builds.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# =============================================================================
# Stage 2: Python runtime that serves backend + static frontend
# =============================================================================
FROM python:3.11-slim

# Don't buffer stdout/stderr — Railway log streams should be live.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Backend Python deps first (changes least often → best cache hit rate).
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt

# Backend source.
COPY backend/ ./backend/

# Pre-built frontend assets from stage 1. main.py reads
# VICTOR_FRONTEND_DIST to locate them.
COPY --from=frontend /app/frontend/dist ./frontend/dist
ENV VICTOR_FRONTEND_DIST=/app/frontend/dist

# Default port for local `docker run`. Railway injects $PORT at runtime.
ENV PORT=8000
EXPOSE 8000

WORKDIR /app/backend

# `sh -c "exec ..."` lets the shell expand $PORT but then replaces itself with
# the Python process, so SIGTERM from the container runtime reaches uvicorn
# (graceful shutdown) instead of being swallowed by the shell.
CMD ["sh", "-c", "exec python -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
