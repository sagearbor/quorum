"""MockDBProvider — in-memory dict-based DB for testing.

No external dependencies. Implements full DBProvider interface.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from . import DBProvider


class MockDBProvider(DBProvider):
    """In-memory DBProvider for tests — no Supabase or Azure SQL needed."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.quorums: list[dict[str, Any]] = []
        self.roles: list[dict[str, Any]] = []
        self.contributions: list[dict[str, Any]] = []
        self.artifacts: list[dict[str, Any]] = []

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    async def get_event(self, slug: str) -> dict[str, Any] | None:
        return next((e for e in self.events if e["slug"] == slug), None)

    async def get_event_by_id(self, event_id: str) -> dict[str, Any] | None:
        return next((e for e in self.events if e["id"] == event_id), None)

    async def create_event(self, data: dict[str, Any]) -> dict[str, Any]:
        row = {**data}
        row.setdefault("created_at", self._now())
        self.events.append(row)
        return row

    async def get_quorum(self, quorum_id: str) -> dict[str, Any] | None:
        return next((q for q in self.quorums if q["id"] == quorum_id), None)

    async def create_quorum(self, data: dict[str, Any]) -> dict[str, Any]:
        row = {**data}
        row.setdefault("created_at", self._now())
        self.quorums.append(row)
        return row

    async def update_quorum(self, quorum_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        for q in self.quorums:
            if q["id"] == quorum_id:
                q.update(updates)
                return q
        return None

    async def create_role(self, data: dict[str, Any]) -> dict[str, Any]:
        self.roles.append(data)
        return data

    async def get_roles(self, quorum_id: str) -> list[dict[str, Any]]:
        return [r for r in self.roles if r["quorum_id"] == quorum_id]

    async def add_contribution(self, data: dict[str, Any]) -> dict[str, Any]:
        row = {**data}
        row.setdefault("created_at", self._now())
        self.contributions.append(row)
        return row

    async def update_contribution(self, contribution_id: str, updates: dict[str, Any]) -> None:
        for c in self.contributions:
            if c["id"] == contribution_id:
                c.update(updates)
                return

    async def get_contributions(self, quorum_id: str) -> list[dict[str, Any]]:
        return sorted(
            [c for c in self.contributions if c["quorum_id"] == quorum_id],
            key=lambda c: c.get("created_at", ""),
        )

    async def get_artifact(self, quorum_id: str) -> dict[str, Any] | None:
        return next((a for a in self.artifacts if a["quorum_id"] == quorum_id), None)

    async def create_artifact(self, data: dict[str, Any]) -> dict[str, Any]:
        row = {**data}
        row.setdefault("created_at", self._now())
        self.artifacts.append(row)
        return row

    async def update_artifact(
        self, artifact_id: str, expected_version: int, updates: dict[str, Any]
    ) -> dict[str, Any] | None:
        for a in self.artifacts:
            if a["id"] == artifact_id and a.get("version") == expected_version:
                a.update(updates)
                return a
        return None

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
