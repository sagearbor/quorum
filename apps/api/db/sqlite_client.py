"""SQLite client that mimics the Supabase Python client fluent API.

Usage::

    client = SQLiteClient("quorum_local.db")
    result = client.table("events").select("*").eq("slug", "my-event").single().execute()
    print(result.data)

All existing ``db.table(...).select(...).eq(...).execute()`` call sites work
unchanged --- the query builder returns the same ``.data`` shape as the
Supabase client.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Registry: columns that store JSON (JSONB / array in Postgres, TEXT in SQLite)
# ---------------------------------------------------------------------------

_JSON_COLUMNS: dict[str, set[str]] = {
    "quorums": {"dashboard_types"},
    "roles": {"prompt_template", "fallback_chain", "blocked_by"},
    "contributions": {"structured_fields"},
    "artifacts": {"sections"},
    "artifact_versions": {"sections", "diff"},
    "agent_configs": {"doc_permissions", "domain_tags"},
    "station_messages": {"tags", "metadata"},
    "agent_documents": {"content", "tags"},
    "document_changes": {"diff", "previous_content", "tags"},
    "agent_insights": {"tags"},
    "agent_requests": {"tags", "response_tags"},
    "oscillation_events": {"involved_roles", "values_sequence"},
    "quorum_state_snapshots": {"snapshot"},
}

# Columns whose default value is a generated UUID (primary keys).
_UUID_PK_COLUMNS: dict[str, str] = {
    "events": "id",
    "quorums": "id",
    "roles": "id",
    "contributions": "id",
    "artifacts": "id",
    "artifact_versions": "id",
    "agent_configs": "id",
    "station_messages": "id",
    "agent_documents": "id",
    "document_changes": "id",
    "agent_insights": "id",
    "agent_requests": "id",
    "oscillation_events": "id",
    "quorum_state_snapshots": "id",
    "synthesis_snapshots": "id",
}


# ---------------------------------------------------------------------------
# Result wrapper
# ---------------------------------------------------------------------------

class APIResponse:
    """Minimal result object matching ``supabase.execute()`` return shape."""

    __slots__ = ("data", "count")

    def __init__(self, data: Any, count: int | None = None):
        self.data = data
        self.count = count


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class SingleRowError(Exception):
    """Raised when ``.single()`` finds != 1 row."""


class MaybeSingleRowError(Exception):
    """Raised when ``.maybe_single()`` finds > 1 row."""


# ---------------------------------------------------------------------------
# Query builder
# ---------------------------------------------------------------------------

class _QueryBuilder:
    """Fluent query builder that accumulates operations, then executes SQL."""

    def __init__(self, table: str, conn: sqlite3.Connection):
        self._table = table
        self._conn = conn
        self._mode: str = "select"  # select | insert | update | delete | upsert
        self._columns: str = "*"
        self._filters: list[tuple[str, str, Any]] = []
        self._order_clauses: list[tuple[str, bool]] = []
        self._limit_val: int | None = None
        self._single: bool = False
        self._maybe_single: bool = False
        self._insert_data: dict | list | None = None
        self._update_data: dict | None = None
        self._upsert_data: dict | list | None = None
        self._on_conflict: str | None = None

    # -- Mode setters -------------------------------------------------------

    def select(self, columns: str = "*") -> _QueryBuilder:
        self._mode = "select"
        self._columns = columns
        return self

    def insert(self, data: dict | list, *, returning: str = "representation") -> _QueryBuilder:  # noqa: ARG002
        self._mode = "insert"
        self._insert_data = data
        return self

    def upsert(self, data: dict | list, *, on_conflict: str = "id") -> _QueryBuilder:
        self._mode = "upsert"
        self._upsert_data = data
        self._on_conflict = on_conflict
        return self

    def update(self, data: dict) -> _QueryBuilder:
        self._mode = "update"
        self._update_data = data
        return self

    def delete(self) -> _QueryBuilder:
        self._mode = "delete"
        return self

    # -- Filter / ordering --------------------------------------------------

    def eq(self, column: str, value: Any) -> _QueryBuilder:
        self._filters.append((column, "=", value))
        return self

    def neq(self, column: str, value: Any) -> _QueryBuilder:
        self._filters.append((column, "!=", value))
        return self

    def gt(self, column: str, value: Any) -> _QueryBuilder:
        self._filters.append((column, ">", value))
        return self

    def gte(self, column: str, value: Any) -> _QueryBuilder:
        self._filters.append((column, ">=", value))
        return self

    def lt(self, column: str, value: Any) -> _QueryBuilder:
        self._filters.append((column, "<", value))
        return self

    def lte(self, column: str, value: Any) -> _QueryBuilder:
        self._filters.append((column, "<=", value))
        return self

    def in_(self, column: str, values: list) -> _QueryBuilder:
        self._filters.append((column, "IN", values))
        return self

    def like(self, column: str, pattern: str) -> _QueryBuilder:
        self._filters.append((column, "LIKE", pattern))
        return self

    def ilike(self, column: str, pattern: str) -> _QueryBuilder:
        # SQLite LIKE is case-insensitive for ASCII by default
        self._filters.append((column, "LIKE", pattern))
        return self

    def is_(self, column: str, value: Any) -> _QueryBuilder:
        if value is None:
            self._filters.append((column, "IS", None))
        else:
            self._filters.append((column, "IS", value))
        return self

    def order(self, column: str, *, desc: bool = False) -> _QueryBuilder:
        self._order_clauses.append((column, desc))
        return self

    def limit(self, n: int) -> _QueryBuilder:
        self._limit_val = n
        return self

    def single(self) -> _QueryBuilder:
        self._single = True
        return self

    def maybe_single(self) -> _QueryBuilder:
        self._maybe_single = True
        return self

    # -- Execution ----------------------------------------------------------

    def execute(self) -> APIResponse:
        if self._mode == "select":
            return self._exec_select()
        elif self._mode == "insert":
            return self._exec_insert()
        elif self._mode == "upsert":
            return self._exec_upsert()
        elif self._mode == "update":
            return self._exec_update()
        elif self._mode == "delete":
            return self._exec_delete()
        else:
            raise ValueError(f"Unknown query mode: {self._mode}")

    # -- Private helpers ----------------------------------------------------

    def _json_cols(self) -> set[str]:
        return _JSON_COLUMNS.get(self._table, set())

    def _serialize_value(self, col: str, val: Any) -> Any:
        """Serialize a Python value for storage in SQLite."""
        if val is None:
            return None
        if col in self._json_cols():
            if isinstance(val, (dict, list)):
                return json.dumps(val)
            # Already a string — pass through (caller may have pre-serialized)
            return val
        if isinstance(val, (dict, list)):
            # Safety net: serialize any dict/list even if not in the registry
            return json.dumps(val)
        if isinstance(val, bool):
            return int(val)
        return val

    def _deserialize_row(self, row: dict) -> dict:
        """Deserialize JSON TEXT columns back to Python objects."""
        json_cols = self._json_cols()
        out: dict[str, Any] = {}
        for k, v in row.items():
            if k in json_cols and isinstance(v, str):
                try:
                    out[k] = json.loads(v)
                except (json.JSONDecodeError, ValueError):
                    out[k] = v
            elif k == "escalated" and self._table == "oscillation_events":
                # SQLite stores booleans as 0/1; convert back
                out[k] = bool(v) if v is not None else False
            elif k in ("auto_create_docs", "auto_suggest_dashboards") and self._table == "agent_configs":
                out[k] = bool(v) if v is not None else False
            else:
                out[k] = v
        return out

    def _build_where(self) -> tuple[str, list]:
        """Build WHERE clause and parameter list from accumulated filters."""
        if not self._filters:
            return "", []
        parts: list[str] = []
        params: list[Any] = []
        for col, op, val in self._filters:
            if op == "IN":
                if not val:
                    # Empty IN list — match nothing
                    parts.append("0")
                else:
                    placeholders = ", ".join("?" for _ in val)
                    parts.append(f'"{col}" IN ({placeholders})')
                    params.extend(val)
            elif op == "IS" and val is None:
                parts.append(f'"{col}" IS NULL')
            elif op == "IS":
                parts.append(f'"{col}" IS ?')
                params.append(val)
            else:
                parts.append(f'"{col}" {op} ?')
                params.append(val)
        return " WHERE " + " AND ".join(parts), params

    def _build_order(self) -> str:
        if not self._order_clauses:
            return ""
        parts = []
        for col, desc in self._order_clauses:
            direction = "DESC" if desc else "ASC"
            parts.append(f'"{col}" {direction}')
        return " ORDER BY " + ", ".join(parts)

    def _build_limit(self) -> str:
        if self._limit_val is not None:
            return f" LIMIT {self._limit_val}"
        return ""

    def _apply_single(self, rows: list[dict]) -> APIResponse:
        """Apply .single() / .maybe_single() semantics."""
        if self._single:
            if len(rows) == 0:
                raise SingleRowError(
                    f"Expected exactly one row from '{self._table}', got 0"
                )
            if len(rows) > 1:
                raise SingleRowError(
                    f"Expected exactly one row from '{self._table}', got {len(rows)}"
                )
            return APIResponse(data=rows[0])
        if self._maybe_single:
            if len(rows) == 0:
                return APIResponse(data=None)
            if len(rows) > 1:
                raise MaybeSingleRowError(
                    f"Expected 0 or 1 rows from '{self._table}', got {len(rows)}"
                )
            return APIResponse(data=rows[0])
        return APIResponse(data=rows)

    def _get_table_columns(self) -> list[str]:
        """Return the column names for the current table."""
        cursor = self._conn.execute(f'PRAGMA table_info("{self._table}")')
        return [row["name"] for row in cursor.fetchall()]

    def _fill_defaults(self, data: dict) -> dict:
        """Fill in server-side defaults that SQLite can't auto-generate."""
        table = self._table
        table_cols = set(self._get_table_columns())
        pk_col = _UUID_PK_COLUMNS.get(table, "id")

        if pk_col in table_cols and (pk_col not in data or data[pk_col] is None):
            data[pk_col] = str(uuid.uuid4())

        # Timestamp defaults — only if the table actually has the column
        now = datetime.now(timezone.utc).isoformat()
        if "created_at" in table_cols and ("created_at" not in data or data["created_at"] is None):
            data["created_at"] = now
        if "updated_at" in table_cols and ("updated_at" not in data or data["updated_at"] is None):
            data["updated_at"] = now

        return data

    # -- SELECT -------------------------------------------------------------

    def _exec_select(self) -> APIResponse:
        if self._columns == "*":
            col_clause = "*"
        else:
            cols = [c.strip() for c in self._columns.split(",")]
            col_clause = ", ".join(f'"{c}"' for c in cols)

        where_clause, params = self._build_where()
        order_clause = self._build_order()
        limit_clause = self._build_limit()

        sql = f'SELECT {col_clause} FROM "{self._table}"{where_clause}{order_clause}{limit_clause}'
        cursor = self._conn.execute(sql, params)
        rows = [self._deserialize_row(dict(r)) for r in cursor.fetchall()]
        return self._apply_single(rows)

    # -- INSERT -------------------------------------------------------------

    def _exec_insert(self) -> APIResponse:
        data = self._insert_data
        if data is None:
            raise ValueError("insert() called without data")

        rows_to_insert = [data] if isinstance(data, dict) else data
        inserted: list[dict] = []

        for row in rows_to_insert:
            row = dict(row)  # copy to avoid mutating caller's data
            row = self._fill_defaults(row)

            cols: list[str] = []
            vals: list[Any] = []
            for k, v in row.items():
                cols.append(f'"{k}"')
                vals.append(self._serialize_value(k, v))

            placeholders = ", ".join("?" for _ in vals)
            col_names = ", ".join(cols)
            sql = f'INSERT INTO "{self._table}" ({col_names}) VALUES ({placeholders})'
            self._conn.execute(sql, vals)
            inserted.append(row)

        self._conn.commit()

        # Return deserialized rows (matching Supabase returning behavior)
        result_rows = [self._deserialize_row(r) for r in inserted]
        return self._apply_single(result_rows)

    # -- UPSERT -------------------------------------------------------------

    def _exec_upsert(self) -> APIResponse:
        data = self._upsert_data
        if data is None:
            raise ValueError("upsert() called without data")

        conflict_col = self._on_conflict or "id"
        rows_to_upsert = [data] if isinstance(data, dict) else data
        upserted: list[dict] = []

        for row in rows_to_upsert:
            row = dict(row)
            row = self._fill_defaults(row)

            cols: list[str] = []
            vals: list[Any] = []
            for k, v in row.items():
                cols.append(f'"{k}"')
                vals.append(self._serialize_value(k, v))

            placeholders = ", ".join("?" for _ in vals)
            col_names = ", ".join(cols)
            update_set = ", ".join(
                f'{c} = excluded.{c.strip(chr(34))}' for c in cols if c.strip('"') != conflict_col
            )

            sql = (
                f'INSERT INTO "{self._table}" ({col_names}) VALUES ({placeholders}) '
                f'ON CONFLICT("{conflict_col}") DO UPDATE SET {update_set}'
            )
            self._conn.execute(sql, vals)
            upserted.append(row)

        self._conn.commit()

        result_rows = [self._deserialize_row(r) for r in upserted]
        return self._apply_single(result_rows)

    # -- UPDATE -------------------------------------------------------------

    def _exec_update(self) -> APIResponse:
        data = self._update_data
        if data is None:
            raise ValueError("update() called without data")

        set_parts: list[str] = []
        set_params: list[Any] = []
        for k, v in data.items():
            set_parts.append(f'"{k}" = ?')
            set_params.append(self._serialize_value(k, v))

        where_clause, where_params = self._build_where()
        sql = f'UPDATE "{self._table}" SET {", ".join(set_parts)}{where_clause}'
        params = set_params + where_params

        # First, select the rows we're about to update so we can return them
        select_where, select_params = self._build_where()
        select_sql = f'SELECT * FROM "{self._table}"{select_where}'
        cursor = self._conn.execute(select_sql, select_params)
        rows_before = [dict(r) for r in cursor.fetchall()]

        self._conn.execute(sql, params)
        self._conn.commit()

        # If CAS-style update matched no rows (e.g. version mismatch),
        # return empty — callers check len(result.data).
        if not rows_before:
            return self._apply_single([])

        # Re-select updated rows to get their current state
        # Build filter on PKs of the rows we found
        pks = [r["id"] for r in rows_before if "id" in r]
        if pks:
            placeholders = ", ".join("?" for _ in pks)
            re_sql = f'SELECT * FROM "{self._table}" WHERE "id" IN ({placeholders})'
            cursor = self._conn.execute(re_sql, pks)
            updated_rows = [self._deserialize_row(dict(r)) for r in cursor.fetchall()]
        else:
            # Fallback: apply the update data on top of the pre-update rows
            updated_rows = []
            for row in rows_before:
                merged = {**row, **data}
                updated_rows.append(self._deserialize_row(merged))

        return self._apply_single(updated_rows)

    # -- DELETE -------------------------------------------------------------

    def _exec_delete(self) -> APIResponse:
        where_clause, params = self._build_where()

        # Capture rows before deleting
        select_sql = f'SELECT * FROM "{self._table}"{where_clause}'
        cursor = self._conn.execute(select_sql, params)
        deleted_rows = [self._deserialize_row(dict(r)) for r in cursor.fetchall()]

        sql = f'DELETE FROM "{self._table}"{where_clause}'
        self._conn.execute(sql, params)
        self._conn.commit()

        return APIResponse(data=deleted_rows)


# ---------------------------------------------------------------------------
# RPC stub
# ---------------------------------------------------------------------------

class _RPCBuilder:
    """Stub for ``client.rpc("function_name", params)`` calls.

    SQLite does not support Postgres functions.  This raises a clear error
    so callers know they need a real Supabase backend for RPC usage.
    """

    def __init__(self, fn_name: str, params: dict):
        self._fn = fn_name
        self._params = params

    def execute(self) -> APIResponse:
        raise NotImplementedError(
            f"RPC '{self._fn}' is not supported by the SQLite local backend. "
            "Use Supabase for Postgres function calls."
        )


# ---------------------------------------------------------------------------
# Main client
# ---------------------------------------------------------------------------

class SQLiteClient:
    """Drop-in replacement for the Supabase ``Client`` that stores data in
    a local SQLite file.

    Initialise the schema automatically on first connection.
    """

    def __init__(self, db_path: str = "quorum_local.db"):
        self._db_path = db_path
        self._conn: sqlite3.Connection | None = None
        self._ensure_schema()

    # -- Public API (matches Supabase client) --------------------------------

    def table(self, name: str) -> _QueryBuilder:
        return _QueryBuilder(name, self._get_conn())

    def rpc(self, fn_name: str, params: dict | None = None) -> _RPCBuilder:
        return _RPCBuilder(fn_name, params or {})

    # -- Connection management -----------------------------------------------

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(self._db_path)
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
        return self._conn

    def _ensure_schema(self) -> None:
        """Create tables if the database is empty or missing."""
        conn = self._get_conn()
        schema_path = Path(__file__).parent / "sqlite_schema.sql"
        if schema_path.exists():
            schema_sql = schema_path.read_text()
            conn.executescript(schema_sql)
        else:
            raise FileNotFoundError(
                f"SQLite schema not found at {schema_path}. "
                "Ensure db/sqlite_schema.sql exists."
            )

    def close(self) -> None:
        """Close the underlying SQLite connection."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None
