"""SupabaseProvider — wraps existing supabase-py calls from apps/api."""

from __future__ import annotations

import os
from typing import Any

from supabase import Client, create_client

from . import DBProvider

_client: Client | None = None


def _get_supabase() -> Client:
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_KEY"]
        _client = create_client(url, key)
    return _client


class SupabaseProvider(DBProvider):
    """DBProvider backed by Supabase (Postgres + realtime)."""

    def __init__(self, client: Client | None = None):
        self._client = client

    @property
    def db(self) -> Client:
        if self._client is not None:
            return self._client
        return _get_supabase()

    async def get_event(self, slug: str) -> dict[str, Any] | None:
        result = self.db.table("events").select("*").eq("slug", slug).single().execute()
        return result.data

    async def get_event_by_id(self, event_id: str) -> dict[str, Any] | None:
        result = self.db.table("events").select("*").eq("id", event_id).single().execute()
        return result.data

    async def create_event(self, data: dict[str, Any]) -> dict[str, Any]:
        result = self.db.table("events").insert(data).execute()
        return result.data[0]

    async def get_quorum(self, quorum_id: str) -> dict[str, Any] | None:
        result = self.db.table("quorums").select("*").eq("id", quorum_id).single().execute()
        return result.data

    async def create_quorum(self, data: dict[str, Any]) -> dict[str, Any]:
        result = self.db.table("quorums").insert(data).execute()
        return result.data[0]

    async def update_quorum(self, quorum_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        result = self.db.table("quorums").update(updates).eq("id", quorum_id).execute()
        return result.data[0] if result.data else None

    async def create_role(self, data: dict[str, Any]) -> dict[str, Any]:
        result = self.db.table("roles").insert(data).execute()
        return result.data[0]

    async def get_roles(self, quorum_id: str) -> list[dict[str, Any]]:
        result = self.db.table("roles").select("*").eq("quorum_id", quorum_id).execute()
        return result.data

    async def add_contribution(self, data: dict[str, Any]) -> dict[str, Any]:
        result = self.db.table("contributions").insert(data).execute()
        return result.data[0]

    async def update_contribution(self, contribution_id: str, updates: dict[str, Any]) -> None:
        self.db.table("contributions").update(updates).eq("id", contribution_id).execute()

    async def get_contributions(self, quorum_id: str) -> list[dict[str, Any]]:
        result = (
            self.db.table("contributions")
            .select("*")
            .eq("quorum_id", quorum_id)
            .order("created_at")
            .execute()
        )
        return result.data

    async def get_artifact(self, quorum_id: str) -> dict[str, Any] | None:
        result = self.db.table("artifacts").select("*").eq("quorum_id", quorum_id).execute()
        return result.data[0] if result.data else None

    async def create_artifact(self, data: dict[str, Any]) -> dict[str, Any]:
        result = self.db.table("artifacts").insert(data).execute()
        return result.data[0]

    async def update_artifact(
        self, artifact_id: str, expected_version: int, updates: dict[str, Any]
    ) -> dict[str, Any] | None:
        result = (
            self.db.table("artifacts")
            .update(updates)
            .eq("id", artifact_id)
            .eq("version", expected_version)
            .execute()
        )
        return result.data[0] if result.data else None

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
