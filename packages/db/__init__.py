"""DB provider interface + factory.

Switches between Supabase (default) and Azure SQL based on DB_PROVIDER env var.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Any


class DBProvider(ABC):
    """Abstract database provider — all DB access goes through this interface."""

    @abstractmethod
    async def get_event(self, slug: str) -> dict[str, Any] | None:
        """Fetch an event by slug. Returns None if not found."""

    @abstractmethod
    async def get_event_by_id(self, event_id: str) -> dict[str, Any] | None:
        """Fetch an event by ID. Returns None if not found."""

    @abstractmethod
    async def create_event(self, data: dict[str, Any]) -> dict[str, Any]:
        """Insert a new event row. Returns the created row."""

    @abstractmethod
    async def get_quorum(self, quorum_id: str) -> dict[str, Any] | None:
        """Fetch a single quorum by ID. Returns None if not found."""

    @abstractmethod
    async def create_quorum(self, data: dict[str, Any]) -> dict[str, Any]:
        """Insert a new quorum row. Returns the created row."""

    @abstractmethod
    async def update_quorum(self, quorum_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Update a quorum row. Returns updated row or None."""

    @abstractmethod
    async def create_role(self, data: dict[str, Any]) -> dict[str, Any]:
        """Insert a new role row."""

    @abstractmethod
    async def get_roles(self, quorum_id: str) -> list[dict[str, Any]]:
        """Get all roles for a quorum."""

    @abstractmethod
    async def add_contribution(self, data: dict[str, Any]) -> dict[str, Any]:
        """Insert a new contribution row."""

    @abstractmethod
    async def update_contribution(self, contribution_id: str, updates: dict[str, Any]) -> None:
        """Update a contribution row."""

    @abstractmethod
    async def get_contributions(self, quorum_id: str) -> list[dict[str, Any]]:
        """Get all contributions for a quorum, ordered by created_at."""

    @abstractmethod
    async def get_artifact(self, quorum_id: str) -> dict[str, Any] | None:
        """Get the artifact for a quorum, or None."""

    @abstractmethod
    async def create_artifact(self, data: dict[str, Any]) -> dict[str, Any]:
        """Insert a new artifact row."""

    @abstractmethod
    async def update_artifact(
        self, artifact_id: str, expected_version: int, updates: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Update artifact with optimistic locking (CAS on version).

        Returns updated row, or None if version mismatch.
        """

    @abstractmethod
    async def get_quorum_state(self, quorum_id: str) -> dict[str, Any] | None:
        """Get full quorum state: quorum + contributions + roles + artifact.

        Returns None if quorum not found. Otherwise returns:
        {quorum, contributions, roles, artifact}
        """


_db_provider: DBProvider | None = None


def get_db_provider() -> DBProvider:
    """Return the configured DBProvider singleton."""
    global _db_provider
    if _db_provider is None:
        provider = os.getenv("DB_PROVIDER", "supabase")
        if provider == "azure":
            from .azure_provider import AzureSQLProvider
            _db_provider = AzureSQLProvider()
        else:
            from .supabase_provider import SupabaseProvider
            _db_provider = SupabaseProvider()
    return _db_provider


def reset_db_provider() -> None:
    """Reset the singleton (for testing)."""
    global _db_provider
    _db_provider = None


def set_db_provider(provider: DBProvider) -> None:
    """Override the singleton (for testing)."""
    global _db_provider
    _db_provider = provider
