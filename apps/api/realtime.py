"""Realtime provider abstraction.

Switches between Supabase WebSocket (default) and polling fallback
based on DB_PROVIDER env var.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Any

from .ws_manager import manager


class RealtimeProvider(ABC):
    """Abstract realtime broadcast provider."""

    @abstractmethod
    async def broadcast(self, quorum_id: str, event_type: str, data: dict[str, Any]) -> None:
        """Broadcast an event to all listeners for a quorum."""


class SupabaseRealtimeProvider(RealtimeProvider):
    """Wraps the existing WebSocket ConnectionManager."""

    async def broadcast(self, quorum_id: str, event_type: str, data: dict[str, Any]) -> None:
        await manager.broadcast(quorum_id, {"type": event_type, "data": data})


class PollingRealtimeProvider(RealtimeProvider):
    """No-op provider — clients poll GET /quorums/{id}/poll instead."""

    async def broadcast(self, quorum_id: str, event_type: str, data: dict[str, Any]) -> None:
        pass


_realtime_provider: RealtimeProvider | None = None


def get_realtime_provider() -> RealtimeProvider:
    """Return the configured RealtimeProvider singleton."""
    global _realtime_provider
    if _realtime_provider is None:
        if os.getenv("DB_PROVIDER", "supabase") == "azure":
            _realtime_provider = PollingRealtimeProvider()
        else:
            _realtime_provider = SupabaseRealtimeProvider()
    return _realtime_provider


def reset_realtime_provider() -> None:
    """Reset the singleton (for testing)."""
    global _realtime_provider
    _realtime_provider = None


def set_realtime_provider(provider: RealtimeProvider) -> None:
    """Override the singleton (for testing)."""
    global _realtime_provider
    _realtime_provider = provider
