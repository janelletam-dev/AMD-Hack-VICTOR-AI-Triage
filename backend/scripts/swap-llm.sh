#!/usr/bin/env bash
# swap-llm.sh — flip VLLM_BASE_URL between droplet and local Ollama, restart
# the backend, and verify the new endpoint with /health/full.
#
# Usage:
#   ./scripts/swap-llm.sh local              # flip to local Ollama
#   ./scripts/swap-llm.sh droplet <ip>       # flip to MI300X / Reserved IP
#   ./scripts/swap-llm.sh status             # show current target

set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env"
[ -f "$ENV_FILE" ] || { echo "no .env found in $(pwd)"; exit 1; }

mode="${1:-status}"

set_env() {
  local key=$1 val=$2
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i '' "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

current_url() { grep -E '^VLLM_BASE_URL=' "$ENV_FILE" | head -1 | cut -d'=' -f2-; }
current_model() { grep -E '^VLLM_MODEL=' "$ENV_FILE" | head -1 | cut -d'=' -f2-; }

case "$mode" in
  local)
    set_env "VLLM_BASE_URL" "http://localhost:11434/v1"
    set_env "VLLM_MODEL"    "llama3.1:8b"
    set_env "VLLM_API_KEY"  "ollama-local"
    echo "→ local Ollama. Make sure 'ollama serve' is running."
    ;;
  droplet)
    ip="${2:-}"
    [ -n "$ip" ] || { echo "usage: $0 droplet <reserved-ip>"; exit 1; }
    set_env "VLLM_BASE_URL" "http://${ip}:8000/v1"
    echo "→ droplet at ${ip}. Make sure vLLM is serving on :8000 and firewall allows it."
    ;;
  status)
    echo "VLLM_BASE_URL=$(current_url)"
    echo "VLLM_MODEL=$(current_model)"
    exit 0
    ;;
  *)
    echo "usage: $0 {local|droplet <ip>|status}"; exit 1
    ;;
esac

# Restart backend (assumes it's running under uvicorn) so the new .env is loaded.
echo "Restarting backend..."
pkill -f "uvicorn main:app" 2>/dev/null || true
sleep 1
.venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload &> /tmp/victor-backend.log &
sleep 3

# Verify
echo "Verifying via /health/full..."
curl -s http://localhost:8000/health/full \
  | python3 -c "import json,sys; d=json.load(sys.stdin); c=[x for x in d['checks'] if x['service']=='llm'][0]; print(f\"  llm: {c['status']} — {c['detail']}\")"
