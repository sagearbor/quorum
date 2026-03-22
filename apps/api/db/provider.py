"""Abstract database provider interface."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class DatabaseProvider(ABC):
    """Pluggable database backend.

    Implementations: SupabaseDatabaseProvider, PostgresDatabaseProvider.
    """

    @abstractmethod
    def get_client(self) -> Any:
        """Return the underlying client (Supabase Client, asyncpg pool, etc.)."""

    @abstractmethod
    async def execute(self, query: str, params: dict | None = None) -> list[dict]:
        """Execute a query and return rows as dicts."""
