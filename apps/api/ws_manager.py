"""WebSocket connection manager with per-quorum 1s debounce."""

import asyncio
import json
import time
from typing import Any

from fastapi import WebSocket


class ConnectionManager:
    """Manages WebSocket connections grouped by quorum_id.

    Debounce: at most one broadcast per quorum per second.  When a
    broadcast is requested within the cooldown window, the message is
    buffered and sent once the window expires.
    """

    def __init__(self) -> None:
        # quorum_id -> set of connected websockets
        self._connections: dict[str, set[WebSocket]] = {}
        # quorum_id -> last broadcast epoch
        self._last_broadcast: dict[str, float] = {}
        # quorum_id -> pending debounce task
        self._pending: dict[str, asyncio.Task] = {}
        # quorum_id -> latest buffered message (newest wins)
        self._buffer: dict[str, str] = {}

    async def connect(self, quorum_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self._connections.setdefault(quorum_id, set()).add(ws)

    def disconnect(self, quorum_id: str, ws: WebSocket) -> None:
        conns = self._connections.get(quorum_id)
        if conns:
            conns.discard(ws)
            if not conns:
                del self._connections[quorum_id]

    async def broadcast(self, quorum_id: str, message: dict[str, Any]) -> None:
        """Broadcast a message to all connections for a quorum, debounced to 1s."""
        payload = json.dumps(message)
        now = time.monotonic()
        last = self._last_broadcast.get(quorum_id, 0.0)
        elapsed = now - last

        if elapsed >= 1.0:
            await self._send_to_all(quorum_id, payload)
            self._last_broadcast[quorum_id] = now
        else:
            # Buffer the latest message and schedule flush
            self._buffer[quorum_id] = payload
            if quorum_id not in self._pending:
                delay = 1.0 - elapsed
                self._pending[quorum_id] = asyncio.create_task(
                    self._flush_after(quorum_id, delay)
                )

    async def _flush_after(self, quorum_id: str, delay: float) -> None:
        await asyncio.sleep(delay)
        payload = self._buffer.pop(quorum_id, None)
        self._pending.pop(quorum_id, None)
        if payload:
            await self._send_to_all(quorum_id, payload)
            self._last_broadcast[quorum_id] = time.monotonic()

    async def _send_to_all(self, quorum_id: str, payload: str) -> None:
        conns = self._connections.get(quorum_id, set()).copy()
        dead: list[WebSocket] = []
        for ws in conns:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(quorum_id, ws)


manager = ConnectionManager()
