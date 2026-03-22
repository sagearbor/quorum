"""Mock database provider — in-memory Supabase-compatible fluent API.

Used when QUORUM_TEST_MODE=true so the entire API runs with zero external
dependencies.  The mock stores rows per table in plain dicts and supports
the same .table().select().eq().order().execute() chain that the real
Supabase Python client exposes.
"""

from __future__ import annotations

import copy
import uuid
from datetime import datetime, timezone
from typing import Any

from .provider import DatabaseProvider


class _MockResult:
    """Mimics postgrest.APIResponse — has a .data attribute."""

    def __init__(self, data: Any) -> None:
        self.data = data


class _MockQueryBuilder:
    """Fluent query builder that operates on an in-memory list of rows.

    Supports the subset of the Supabase PostgREST client API used by
    routes.py: select, eq, neq, lt, gt, gte, lte, order, limit, single,
    insert, update, delete, upsert, filter, rpc.
    """

    def __init__(self, table: "_MockTable") -> None:
        self._table = table
        self._filters: list[tuple[str, str, Any]] = []
        self._order_col: str | None = None
        self._order_desc: bool = False
        self._limit_n: int | None = None
        self._is_single: bool = False
        self._op: str = "select"  # select | insert | update | delete | upsert
        self._select_cols: str = "*"
        self._payload: Any = None

    # -- filter helpers -------------------------------------------------------

    def select(self, cols: str = "*") -> "_MockQueryBuilder":
        self._select_cols = cols
        self._op = "select"
        return self

    def eq(self, col: str, val: Any) -> "_MockQueryBuilder":
        self._filters.append((col, "eq", val))
        return self

    def neq(self, col: str, val: Any) -> "_MockQueryBuilder":
        self._filters.append((col, "neq", val))
        return self

    def lt(self, col: str, val: Any) -> "_MockQueryBuilder":
        self._filters.append((col, "lt", val))
        return self

    def gt(self, col: str, val: Any) -> "_MockQueryBuilder":
        self._filters.append((col, "gt", val))
        return self

    def gte(self, col: str, val: Any) -> "_MockQueryBuilder":
        self._filters.append((col, "gte", val))
        return self

    def lte(self, col: str, val: Any) -> "_MockQueryBuilder":
        self._filters.append((col, "lte", val))
        return self

    def filter(self, col: str, op: str, val: Any) -> "_MockQueryBuilder":
        self._filters.append((col, op, val))
        return self

    def order(self, col: str, desc: bool = False) -> "_MockQueryBuilder":
        self._order_col = col
        self._order_desc = desc
        return self

    def limit(self, n: int) -> "_MockQueryBuilder":
        self._limit_n = n
        return self

    def single(self) -> "_MockQueryBuilder":
        self._is_single = True
        return self

    # -- mutation helpers ------------------------------------------------------

    def insert(self, row: dict | list[dict]) -> "_MockQueryBuilder":
        self._op = "insert"
        self._payload = row
        return self

    def update(self, data: dict) -> "_MockQueryBuilder":
        self._op = "update"
        self._payload = data
        return self

    def delete(self) -> "_MockQueryBuilder":
        self._op = "delete"
        return self

    def upsert(self, row: dict | list[dict]) -> "_MockQueryBuilder":
        self._op = "upsert"
        self._payload = row
        return self

    # -- execute ---------------------------------------------------------------

    def _apply_filters(self, rows: list[dict]) -> list[dict]:
        result = rows
        for col, op, val in self._filters:
            if op == "eq":
                result = [r for r in result if r.get(col) == val]
            elif op == "neq":
                result = [r for r in result if r.get(col) != val]
            elif op == "lt":
                result = [r for r in result if r.get(col) is not None and r.get(col) < val]
            elif op == "gt":
                result = [r for r in result if r.get(col) is not None and r.get(col) > val]
            elif op == "gte":
                result = [r for r in result if r.get(col) is not None and r.get(col) >= val]
            elif op == "lte":
                result = [r for r in result if r.get(col) is not None and r.get(col) <= val]
        return result

    def _project(self, rows: list[dict]) -> list[dict]:
        if self._select_cols == "*":
            return rows
        cols = [c.strip() for c in self._select_cols.split(",")]
        return [{c: r.get(c) for c in cols} for r in rows]

    def execute(self) -> _MockResult:
        now = datetime.now(timezone.utc).isoformat()

        if self._op == "insert":
            rows_to_insert = self._payload if isinstance(self._payload, list) else [self._payload]
            inserted = []
            for row in rows_to_insert:
                row = copy.deepcopy(row)
                row.setdefault("created_at", now)
                row.setdefault("updated_at", now)
                self._table.rows.append(row)
                inserted.append(row)
            return _MockResult(inserted)

        if self._op == "upsert":
            rows_to_upsert = self._payload if isinstance(self._payload, list) else [self._payload]
            upserted = []
            for row in rows_to_upsert:
                row = copy.deepcopy(row)
                row.setdefault("created_at", now)
                row.setdefault("updated_at", now)
                # Try to find existing row by id
                existing_idx = None
                if "id" in row:
                    for i, existing in enumerate(self._table.rows):
                        if existing.get("id") == row["id"]:
                            existing_idx = i
                            break
                if existing_idx is not None:
                    self._table.rows[existing_idx].update(row)
                    upserted.append(self._table.rows[existing_idx])
                else:
                    self._table.rows.append(row)
                    upserted.append(row)
            return _MockResult(upserted)

        if self._op == "update":
            filtered = self._apply_filters(self._table.rows)
            updated = []
            for row in filtered:
                row.update(self._payload)
                row["updated_at"] = now
                updated.append(copy.deepcopy(row))
            return _MockResult(updated)

        if self._op == "delete":
            filtered = self._apply_filters(self._table.rows)
            filtered_ids = {id(r) for r in filtered}
            self._table.rows = [r for r in self._table.rows if id(r) not in filtered_ids]
            return _MockResult(filtered)

        # select
        rows = copy.deepcopy(self._apply_filters(self._table.rows))

        if self._order_col:
            rows.sort(
                key=lambda r: r.get(self._order_col, ""),
                reverse=self._order_desc,
            )

        if self._limit_n is not None:
            rows = rows[: self._limit_n]

        rows = self._project(rows)

        if self._is_single:
            return _MockResult(rows[0] if rows else None)

        return _MockResult(rows)


class _MockTable:
    """In-memory table that returns _MockQueryBuilder for every query."""

    def __init__(self) -> None:
        self.rows: list[dict] = []

    def _builder(self) -> _MockQueryBuilder:
        return _MockQueryBuilder(self)

    # Entry points — each returns a fresh builder
    def select(self, cols: str = "*") -> _MockQueryBuilder:
        b = self._builder()
        return b.select(cols)

    def insert(self, row: dict | list[dict]) -> _MockQueryBuilder:
        b = self._builder()
        return b.insert(row)

    def update(self, data: dict) -> _MockQueryBuilder:
        b = self._builder()
        return b.update(data)

    def delete(self) -> _MockQueryBuilder:
        b = self._builder()
        return b.delete()

    def upsert(self, row: dict | list[dict]) -> _MockQueryBuilder:
        b = self._builder()
        return b.upsert(row)


class _MockSupabaseClient:
    """In-memory client mimicking the Supabase Python client's table() API."""

    def __init__(self) -> None:
        self._tables: dict[str, _MockTable] = {}

    def table(self, name: str) -> _MockTable:
        if name not in self._tables:
            self._tables[name] = _MockTable()
        return self._tables[name]

    def rpc(self, fn_name: str, params: dict | None = None) -> _MockResult:
        return _MockResult([])


class MockDatabaseProvider(DatabaseProvider):
    """In-memory database provider for QUORUM_TEST_MODE.

    Provides a Supabase-compatible fluent API backed by plain Python dicts.
    No external services required.
    """

    def __init__(self) -> None:
        self._client = _MockSupabaseClient()

    def get_client(self) -> _MockSupabaseClient:
        return self._client

    async def execute(self, query: str, params: dict | None = None) -> list[dict]:
        return []
