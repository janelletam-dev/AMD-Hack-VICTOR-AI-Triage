"""Thymia Helios + Apollo (+ CVD if available) voice biomarker client.

Day 2 — fan-out audio frames in parallel with Deepgram, return rolling scores.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from config import settings

log = logging.getLogger("victor.thymia")


@dataclass
class HeliosScores:
    stress: float = 0.0
    distress: float = 0.0
    burnout: float = 0.0
    tiredness: float = 0.0


@dataclass
class ApolloScores:
    anxiety: float = 0.0
    depression: float = 0.0


@dataclass
class BiomarkerSnapshot:
    helios: HeliosScores = field(default_factory=HeliosScores)
    apollo: ApolloScores = field(default_factory=ApolloScores)
    cvd: dict[str, float] = field(default_factory=dict)


class ThymiaService:
    def __init__(self) -> None:
        self.api_key = settings.thymia_api_key
        self.policy = settings.thymia_policy
        self.biomarkers = [b.strip() for b in settings.thymia_biomarkers.split(",")]
        if not self.api_key:
            log.warning("THYMIA_API_KEY not set — biomarkers will be mocked")

    async def submit_window(self, pcm16: bytes) -> BiomarkerSnapshot:
        """Submit a windowed audio chunk; return the latest biomarker snapshot."""
        # TODO(Day 2): real Thymia API call
        return BiomarkerSnapshot()
