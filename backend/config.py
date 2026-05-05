"""Environment + app-wide constants."""
from __future__ import annotations

import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    # Deepgram
    deepgram_api_key: str = os.getenv("DEEPGRAM_API_KEY", "")

    # Thymia
    thymia_api_key: str = os.getenv("THYMIA_API_KEY", "")
    thymia_policy: str = os.getenv("THYMIA_POLICY", "demo_wellbeing_awareness")
    thymia_biomarkers: str = os.getenv("THYMIA_BIOMARKERS", "helios,apollo")

    # LLM endpoint — OpenAI-compatible. Defaults point at local Ollama so the
    # swarm runs on a laptop while LoRA fine-tunes on MI300X. Swap to vLLM
    # by setting VLLM_BASE_URL to http://<droplet-ip>:8000/v1 + the served
    # model name in VLLM_MODEL.
    vllm_base_url: str = os.getenv("VLLM_BASE_URL", "http://localhost:11434/v1")
    vllm_model: str = os.getenv("VLLM_MODEL", "llama3.1:8b")
    # Most OpenAI-compatible servers (Ollama, vLLM) require *some* api_key
    # string, but the value is unused locally. Keep configurable for hosted
    # vLLM deployments that do enforce a key.
    vllm_api_key: str = os.getenv("VLLM_API_KEY", "ollama-local")

    # ElevenLabs
    elevenlabs_api_key: str = os.getenv("ELEVENLABS_API_KEY", "")
    elevenlabs_voice_victor: str = os.getenv("ELEVENLABS_VOICE_VICTOR", "")
    elevenlabs_voice_jackie: str = os.getenv("ELEVENLABS_VOICE_JACKIE", "")

    # App
    session_secret: str = os.getenv("SESSION_SECRET", "dev-secret-change-me")
    node_env: str = os.getenv("NODE_ENV", "development")

    # Audio constants — see PRD §6 + §12.1
    sample_rate_hz: int = 16_000
    frame_samples: int = 640        # 40ms at 16kHz
    frame_bytes: int = 1280         # 640 samples × 2 bytes (PCM16)


settings = Settings()
