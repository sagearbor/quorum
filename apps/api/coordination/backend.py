"""Abstract base class for coordination backends."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class CoordinationBackend(ABC):
    """Interface for quorum coordination — Supabase or A2A."""

    @abstractmethod
    async def submit_contribution(
        self, quorum_id: str, role_id: str, user_token: str,
        content: str, structured_fields: dict[str, str],
    ) -> dict[str, Any]:
        """Submit a contribution and return the created row."""

    @abstractmethod
    async def get_contributions(self, quorum_id: str) -> list[dict[str, Any]]:
        """Return all contributions for a quorum, ordered by created_at."""

    @abstractmethod
    async def get_roles(self, quorum_id: str) -> list[dict[str, Any]]:
        """Return all roles for a quorum."""

    @abstractmethod
    async def get_quorum(self, quorum_id: str) -> dict[str, Any] | None:
        """Return quorum row or None."""

    @abstractmethod
    async def update_quorum_status(self, quorum_id: str, status: str) -> None:
        """Update quorum status field."""

    @abstractmethod
    async def store_synthesis(
        self, quorum_id: str, synthesis_data: dict[str, Any],
    ) -> None:
        """Store a synthesis/snapshot result."""
