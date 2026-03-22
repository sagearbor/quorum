"""Generic Postgres provider — works with any Postgres instance.

Compatible with local Postgres, Neon, Railway, Azure Database for PostgreSQL,
or any service that speaks the Postgres wire protocol.

Requires: ``pip install psycopg[binary]`` (or asyncpg).
Uses DATABASE_URL env var (standard ``postgresql://user:pass@host/db`` format).
"""

from __future__ import annotations

import os
from typing import Any

from provider import DatabaseProvider

_pool: Any = None


class PostgresDatabaseProvider(DatabaseProvider):
    """Direct Postgres connection via psycopg (sync driver, async-compatible)."""

    def __init__(self, database_url: str | None = None) -> None:
        try:
            import psycopg
        except ImportError as exc:
            raise ImportError(
                "psycopg is required for the postgres provider. "
                "Run: pip install 'psycopg[binary]'"
            ) from exc

        self._dsn = database_url or os.environ["DATABASE_URL"]
        self._conn: Any = None

    def _get_conn(self):
        import psycopg

        if self._conn is None or self._conn.closed:
            self._conn = psycopg.connect(self._dsn, autocommit=True)
        return self._conn

    def get_client(self) -> Any:
        return self._get_conn()

    async def execute(self, query: str, params: dict | None = None) -> list[dict]:
        conn = self._get_conn()
        with conn.cursor() as cur:
            cur.execute(query, params)
            if cur.description is None:
                return []
            columns = [desc.name for desc in cur.description]
            return [dict(zip(columns, row)) for row in cur.fetchall()]
