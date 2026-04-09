"""Supabase implementation of CoordinationBackend."""

from __future__ import annotations

import uuid
from typing import Any

from database import get_supabase
from .backend import CoordinationBackend


class SupabaseBackend(CoordinationBackend):
    """Direct Supabase coordination — the default backend."""

    async def submit_contribution(
        self, quorum_id: str, role_id: str, user_token: str,
        content: str, structured_fields: dict[str, str],
    ) -> dict[str, Any]:
        db = get_supabase()
        contribution_id = str(uuid.uuid4())
        row = {
            "id": contribution_id,
            "quorum_id": quorum_id,
            "role_id": role_id,
            "user_token": user_token,
            "content": content,
            "structured_fields": structured_fields,
            "tier_processed": 1,
        }
        db.table("contributions").insert(row).execute()
        return row

    async def get_contributions(self, quorum_id: str) -> list[dict[str, Any]]:
        db = get_supabase()
        result = (
            db.table("contributions")
            .select("*")
            .eq("quorum_id", quorum_id)
            .order("created_at")
            .execute()
        )
        return result.data

    async def get_roles(self, quorum_id: str) -> list[dict[str, Any]]:
        db = get_supabase()
        result = db.table("roles").select("*").eq("quorum_id", quorum_id).execute()
        return result.data

    async def get_quorum(self, quorum_id: str) -> dict[str, Any] | None:
        db = get_supabase()
        result = (
            db.table("quorums").select("*").eq("id", quorum_id).maybe_single().execute()
        )
        return result.data if result else None

    async def update_quorum_status(self, quorum_id: str, status: str) -> None:
        db = get_supabase()
        db.table("quorums").update({"status": status}).eq("id", quorum_id).execute()

    async def store_synthesis(
        self, quorum_id: str, synthesis_data: dict[str, Any],
    ) -> None:
        db = get_supabase()
        db.table("synthesis_snapshots").insert({
            "id": str(uuid.uuid4()),
            "quorum_id": quorum_id,
            **synthesis_data,
        }).execute()
