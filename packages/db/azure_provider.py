"""AzureSQLProvider — SQLAlchemy-based DBProvider for Azure SQL.

When QUORUM_TEST_MODE=true, uses in-memory SQLite instead of real Azure SQL.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    Column,
    DateTime,
    Float,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    select,
    update,
)
from sqlalchemy.engine import Engine

from . import DBProvider

metadata = MetaData()

events_table = Table(
    "events", metadata,
    Column("id", String(36), primary_key=True),
    Column("name", Text, nullable=False),
    Column("slug", Text, nullable=False, unique=True),
    Column("access_code", Text, nullable=False),
    Column("max_active_quorums", Integer, default=5),
    Column("created_by", Text),
    Column("created_at", DateTime, default=lambda: datetime.now(timezone.utc)),
)

quorums_table = Table(
    "quorums", metadata,
    Column("id", String(36), primary_key=True),
    Column("event_id", String(36), nullable=False),
    Column("title", Text, nullable=False),
    Column("description", Text),
    Column("status", String(20), default="open"),
    Column("heat_score", Float, default=0),
    Column("carousel_mode", String(20), default="multi-view"),
    Column("created_at", DateTime, default=lambda: datetime.now(timezone.utc)),
)

roles_table = Table(
    "roles", metadata,
    Column("id", String(36), primary_key=True),
    Column("quorum_id", String(36), nullable=False),
    Column("name", Text, nullable=False),
    Column("capacity", Text, default="unlimited"),
    Column("authority_rank", Integer, default=0),
    Column("prompt_template", Text),  # JSON string
    Column("fallback_chain", Text),   # JSON string (array of UUIDs)
    Column("color", Text),
)

contributions_table = Table(
    "contributions", metadata,
    Column("id", String(36), primary_key=True),
    Column("quorum_id", String(36), nullable=False),
    Column("role_id", String(36), nullable=False),
    Column("user_token", Text),
    Column("content", Text),
    Column("structured_fields", Text),  # JSON string
    Column("tier_processed", Integer, default=1),
    Column("created_at", DateTime, default=lambda: datetime.now(timezone.utc)),
)

artifacts_table = Table(
    "artifacts", metadata,
    Column("id", String(36), primary_key=True),
    Column("quorum_id", String(36), nullable=False),
    Column("version", Integer, default=1),
    Column("content_hash", Text),
    Column("sections", Text),  # JSON string
    Column("status", String(30), default="draft"),
    Column("created_at", DateTime, default=lambda: datetime.now(timezone.utc)),
)


def _json_col(val: Any) -> str | None:
    """Serialize a value to JSON string for storage."""
    if val is None:
        return None
    if isinstance(val, str):
        return val
    return json.dumps(val)


def _parse_json(val: str | None) -> Any:
    """Parse a JSON column back to Python object."""
    if val is None:
        return None
    if isinstance(val, (dict, list)):
        return val
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return val


def _row_to_dict(row, table: Table) -> dict[str, Any]:
    """Convert a SQLAlchemy Row to dict, parsing JSON columns."""
    d = dict(row._mapping)
    json_cols = {"prompt_template", "fallback_chain", "structured_fields", "sections"}
    for col in json_cols:
        if col in d:
            d[col] = _parse_json(d[col])
    # Convert datetime to ISO string
    for col in ("created_at",):
        if col in d and isinstance(d[col], datetime):
            d[col] = d[col].isoformat()
    return d


class AzureSQLProvider(DBProvider):
    """DBProvider backed by Azure SQL (or SQLite in test mode)."""

    def __init__(self, engine: Engine | None = None):
        if engine is not None:
            self._engine = engine
        elif os.getenv("QUORUM_TEST_MODE", "").lower() == "true":
            self._engine = create_engine("sqlite:///:memory:")
        else:
            conn_str = os.environ["AZURE_SQL_CONNECTION_STRING"]
            self._engine = create_engine(conn_str)
        metadata.create_all(self._engine)

    @property
    def engine(self) -> Engine:
        return self._engine

    async def get_event(self, slug: str) -> dict[str, Any] | None:
        with self._engine.connect() as conn:
            row = conn.execute(
                select(events_table).where(events_table.c.slug == slug)
            ).first()
            return _row_to_dict(row, events_table) if row else None

    async def get_event_by_id(self, event_id: str) -> dict[str, Any] | None:
        with self._engine.connect() as conn:
            row = conn.execute(
                select(events_table).where(events_table.c.id == event_id)
            ).first()
            return _row_to_dict(row, events_table) if row else None

    async def create_event(self, data: dict[str, Any]) -> dict[str, Any]:
        row = {**data}
        if "created_at" not in row:
            row["created_at"] = datetime.now(timezone.utc)
        with self._engine.begin() as conn:
            conn.execute(events_table.insert().values(**row))
        return {**row, "created_at": row["created_at"].isoformat() if isinstance(row["created_at"], datetime) else row["created_at"]}

    async def get_quorum(self, quorum_id: str) -> dict[str, Any] | None:
        with self._engine.connect() as conn:
            row = conn.execute(
                select(quorums_table).where(quorums_table.c.id == quorum_id)
            ).first()
            return _row_to_dict(row, quorums_table) if row else None

    async def create_quorum(self, data: dict[str, Any]) -> dict[str, Any]:
        row = {**data}
        if "created_at" not in row:
            row["created_at"] = datetime.now(timezone.utc)
        with self._engine.begin() as conn:
            conn.execute(quorums_table.insert().values(**row))
        return {**row, "created_at": row["created_at"].isoformat() if isinstance(row["created_at"], datetime) else row["created_at"]}

    async def update_quorum(self, quorum_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        with self._engine.begin() as conn:
            conn.execute(
                update(quorums_table).where(quorums_table.c.id == quorum_id).values(**updates)
            )
        return await self.get_quorum(quorum_id)

    async def create_role(self, data: dict[str, Any]) -> dict[str, Any]:
        row = {**data}
        row["prompt_template"] = _json_col(row.get("prompt_template"))
        row["fallback_chain"] = _json_col(row.get("fallback_chain"))
        with self._engine.begin() as conn:
            conn.execute(roles_table.insert().values(**row))
        return data

    async def get_roles(self, quorum_id: str) -> list[dict[str, Any]]:
        with self._engine.connect() as conn:
            rows = conn.execute(
                select(roles_table).where(roles_table.c.quorum_id == quorum_id)
            ).fetchall()
            return [_row_to_dict(r, roles_table) for r in rows]

    async def add_contribution(self, data: dict[str, Any]) -> dict[str, Any]:
        row = {**data}
        row["structured_fields"] = _json_col(row.get("structured_fields"))
        if "created_at" not in row:
            row["created_at"] = datetime.now(timezone.utc)
        with self._engine.begin() as conn:
            conn.execute(contributions_table.insert().values(**row))
        return {**data, "created_at": row["created_at"].isoformat() if isinstance(row["created_at"], datetime) else row["created_at"]}

    async def update_contribution(self, contribution_id: str, updates: dict[str, Any]) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                update(contributions_table)
                .where(contributions_table.c.id == contribution_id)
                .values(**updates)
            )

    async def get_contributions(self, quorum_id: str) -> list[dict[str, Any]]:
        with self._engine.connect() as conn:
            rows = conn.execute(
                select(contributions_table)
                .where(contributions_table.c.quorum_id == quorum_id)
                .order_by(contributions_table.c.created_at)
            ).fetchall()
            return [_row_to_dict(r, contributions_table) for r in rows]

    async def get_artifact(self, quorum_id: str) -> dict[str, Any] | None:
        with self._engine.connect() as conn:
            row = conn.execute(
                select(artifacts_table).where(artifacts_table.c.quorum_id == quorum_id)
            ).first()
            return _row_to_dict(row, artifacts_table) if row else None

    async def create_artifact(self, data: dict[str, Any]) -> dict[str, Any]:
        row = {**data}
        row["sections"] = _json_col(row.get("sections"))
        if "created_at" not in row:
            row["created_at"] = datetime.now(timezone.utc)
        with self._engine.begin() as conn:
            conn.execute(artifacts_table.insert().values(**row))
        return data

    async def update_artifact(
        self, artifact_id: str, expected_version: int, updates: dict[str, Any]
    ) -> dict[str, Any] | None:
        row_updates = {**updates}
        if "sections" in row_updates:
            row_updates["sections"] = _json_col(row_updates["sections"])
        with self._engine.begin() as conn:
            result = conn.execute(
                update(artifacts_table)
                .where(artifacts_table.c.id == artifact_id)
                .where(artifacts_table.c.version == expected_version)
                .values(**row_updates)
            )
            if result.rowcount == 0:
                return None
        # Re-fetch to return updated row
        with self._engine.connect() as conn:
            row = conn.execute(
                select(artifacts_table).where(artifacts_table.c.id == artifact_id)
            ).first()
            return _row_to_dict(row, artifacts_table) if row else None

    async def get_quorum_state(self, quorum_id: str) -> dict[str, Any] | None:
        quorum = await self.get_quorum(quorum_id)
        if not quorum:
            return None
        contributions = await self.get_contributions(quorum_id)
        roles = await self.get_roles(quorum_id)
        artifact = await self.get_artifact(quorum_id)
        return {
            "quorum": quorum,
            "contributions": contributions,
            "roles": roles,
            "artifact": artifact,
        }
