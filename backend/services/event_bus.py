"""Per-room async pub/sub event bus.

Used to fan a single audio stream's downstream events (transcript,
biomarkers, concordance flags, SOAP updates, agent activity) out to any
subscribers — typically one patient WS + one clinician WS per room.

Day 2 — wire properly when concordance engine starts emitting events.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._rooms: dict[str, set[asyncio.Queue]] = defaultdict(set)

    def subscribe(self, room: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._rooms[room].add(q)
        return q

    def unsubscribe(self, room: str, q: asyncio.Queue) -> None:
        self._rooms[room].discard(q)
        if not self._rooms[room]:
            del self._rooms[room]

    async def publish(self, room: str, event: dict[str, Any]) -> None:
        for q in list(self._rooms.get(room, ())):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Drop oldest for slow consumers — events are best-effort.
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                q.put_nowait(event)


bus = EventBus()
