"""Supabase database provider — wraps the existing get_supabase() singleton."""

from __future__ import annotations

from typing import Any

from ..database import get_supabase
from provider import DatabaseProvider


class SupabaseDatabaseProvider(DatabaseProvider):
    """Thin wrapper around the Supabase client.

    Uses the existing ``get_supabase()`` singleton so all current route code
    continues to work unchanged.
    """

    def get_client(self) -> Any:
        return get_supabase()

    async def execute(self, query: str, params: dict | None = None) -> list[dict]:
        client = get_supabase()
        result = client.rpc(query, params or {}).execute()
        return result.data if result.data else []
