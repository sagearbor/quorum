"""Database provider factory — DATABASE_PROVIDER env var selects backend."""

from __future__ import annotations

import os

from .provider import DatabaseProvider

_provider: DatabaseProvider | None = None


def get_database_provider() -> DatabaseProvider:
    """Return the configured DatabaseProvider singleton.

    Set ``DATABASE_PROVIDER`` env var: ``supabase`` (default) or ``postgres``.
    """
    global _provider
    if _provider is not None:
        return _provider

    backend = os.environ.get("DATABASE_PROVIDER", "supabase").lower()

    if backend == "supabase":
        from .supabase_provider import SupabaseDatabaseProvider
        _provider = SupabaseDatabaseProvider()
    elif backend == "postgres":
        from .postgres_provider import PostgresDatabaseProvider
        _provider = PostgresDatabaseProvider()
    else:
        raise ValueError(
            f"Unknown DATABASE_PROVIDER '{backend}'. Choose: supabase, postgres"
        )
    return _provider
