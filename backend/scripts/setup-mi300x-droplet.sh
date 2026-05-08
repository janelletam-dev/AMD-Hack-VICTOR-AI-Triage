#!/usr/bin/env bash
# setup-mi300x-droplet.sh — one-shot setup for the V.I.C.T.O.R. LoRA on
# a DigitalOcean MI300X GPU droplet. Run this AS ROOT on the droplet
# (not on your Mac). Idempotent — safe to re-run.
#
# After this finishes, vLLM is serving the victor-triage LoRA on port
# 8000 and survives reboots via systemd. From Railway, set:
#   VLLM_BASE_URL=http://<reserved-ip>:8000/v1
#   VLLM_MODEL=victor-triage
#
# Prerequisites:
#   - DigitalOcean MI300X GPU droplet running Ubuntu 22.04 (ROCm 6 image)
#   - Cloud Firewall has TCP :8000 open from Railway egress (or 0.0.0.0/0
#     temporarily for testing — tighten before production)
#   - A Reserved IP attached to this droplet (see project_mi300x_reserved_ip
#     memory for the why)
#   - HF_TOKEN exported in the shell that runs this script, OR the LoRA
#     repo is public (jantam13/victor-triage-lora-llama3.1-8b is public,
#     so HF_TOKEN is only needed for the gated base model — see below)
#
# Usage:
#   export HF_TOKEN=hf_xxx          # only if base model is gated for you
#   bash setup-mi300x-droplet.sh

set -euo pipefail

LORA_REPO="jantam13/victor-triage-lora-llama3.1-8b"
BASE_MODEL="NousResearch/Meta-Llama-3.1-8B-Instruct"
SERVED_NAME="victor-triage"

echo "──────────────────────────────────────────────────────────────"
echo "V.I.C.T.O.R. — MI300X vLLM setup"
echo "Base model: ${BASE_MODEL}"
echo "LoRA:       ${LORA_REPO}"
echo "──────────────────────────────────────────────────────────────"

# 1. Verify ROCm is available. DO MI300X images come with ROCm 6
#    pre-installed; if rocm-smi is missing, the user picked the wrong
#    droplet image and needs to recreate.
if ! command -v rocm-smi >/dev/null 2>&1; then
  echo "ERROR: rocm-smi not found. This droplet is not a ROCm image."
  echo "Recreate the droplet using the AMD ROCm 6 image template on DO."
  exit 1
fi
echo "✓ ROCm present:"
rocm-smi --showid | head -10

# 2. Docker — DO ROCm images ship with it; install if missing.
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker…"
  apt-get update -qq
  apt-get install -y -qq docker.io
  systemctl enable --now docker
fi
echo "✓ Docker $(docker --version | awk '{print $3}' | tr -d ',')"

# 3. Hugging Face cache directory — bind-mounted into the vLLM container so
#    repeat starts skip the model download.
mkdir -p /root/.cache/huggingface

# 4. Pull the rocm/vllm image. This is AMD's official vLLM build for
#    ROCm — handles all the torch/rocm/vllm version-pinning hell.
echo "Pulling rocm/vllm image (this takes a few minutes the first time)…"
docker pull rocm/vllm:latest

# 5. Stop any existing vllm container so re-runs are clean.
if docker ps -a --format '{{.Names}}' | grep -q '^vllm-victor$'; then
  echo "Stopping existing vllm-victor container…"
  docker rm -f vllm-victor >/dev/null
fi

# 6. Start vLLM with the LoRA enabled. Notes on each flag:
#    --device /dev/kfd /dev/dri   ROCm GPU device passthrough
#    --group-add video            container needs video group for GPU access
#    --shm-size 8g                vLLM uses shared memory for batching
#    -p 8000:8000                 OpenAI-compatible API on :8000
#    -v ~/.cache/huggingface      cache models across container restarts
#    --enable-lora                load LoRA adapters at runtime
#    --lora-modules               name=repo mapping; "victor-triage" is the
#                                 model name VLLM_MODEL points at
#    --max-model-len 4096         caps context to fit MI300X memory comfortably
echo "Starting vllm-victor container…"
docker run -d \
  --name vllm-victor \
  --restart unless-stopped \
  --device=/dev/kfd \
  --device=/dev/dri \
  --group-add video \
  --shm-size=8g \
  -p 8000:8000 \
  -v /root/.cache/huggingface:/root/.cache/huggingface \
  -e HF_TOKEN="${HF_TOKEN:-}" \
  --entrypoint python3 \
  rocm/vllm:latest \
  -m vllm.entrypoints.openai.api_server \
  --model "${BASE_MODEL}" \
  --served-model-name "${SERVED_NAME}" \
  --enable-lora \
  --lora-modules "${SERVED_NAME}=${LORA_REPO}" \
  --max-model-len 8192 \
  --max-lora-rank 32 \
  --host 0.0.0.0 \
  --port 8000

echo "Container starting. First boot downloads ~16GB of weights — give it"
echo "5–10 minutes. Tail the log to watch progress:"
echo ""
echo "    docker logs -f vllm-victor"
echo ""
echo "When you see 'Uvicorn running on http://0.0.0.0:8000' it's ready."
echo ""
echo "Verify locally on the droplet (still inside SSH):"
echo "    curl -s http://localhost:8000/v1/models | jq"
echo ""
echo "Verify externally (from your Mac, replace <reserved-ip>):"
echo "    curl -s http://<reserved-ip>:8000/v1/models | jq"
echo ""
echo "──────────────────────────────────────────────────────────────"
echo "Setup complete. Next: set Railway env vars"
echo "    VLLM_BASE_URL=http://<reserved-ip>:8000/v1"
echo "    VLLM_MODEL=${SERVED_NAME}"
echo "    VLLM_API_KEY=ollama-local   (or any non-empty string — vLLM"
echo "                                 doesn't enforce auth in this config)"
echo "──────────────────────────────────────────────────────────────"
