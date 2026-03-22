"""Database provider factory — DATABASE_PROVIDER env var selects backend.

When ``QUORUM_TEST_MODE=true``, always returns MockDatabaseProvider regardless
of DATABASE_PROVIDER so the API runs with zero external dependencies.
"""

from __future__ import annotations

import os

from .provider import DatabaseProvider

_provider: DatabaseProvider | None = None


def get_database_provider() -> DatabaseProvider:
    """Return the configured DatabaseProvider singleton.

    Set ``DATABASE_PROVIDER`` env var: ``supabase`` (default) or ``postgres``.
    When ``QUORUM_TEST_MODE=true``, always returns the in-memory mock.
    """
    global _provider
    if _provider is not None:
        return _provider

    test_mode = os.environ.get("QUORUM_TEST_MODE", "").lower() == "true"

    if test_mode:
        from .mock_provider import MockDatabaseProvider
        _provider = MockDatabaseProvider()
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


def reset_provider() -> None:
    """Reset the singleton — used by tests to inject fresh providers."""
    global _provider
    _provider = None
