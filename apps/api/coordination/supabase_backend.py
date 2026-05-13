"""Supabase implementation of CoordinationBackend."""

from __future__ import annotations

import uuid
from typing import Any

from database import get_supabase
from db.aexec import aexec  # 12.6: thread-pool wrapper for sync Supabase calls.
from .backend import CoordinationBackend


class SupabaseBackend(CoordinationBackend):
    """Direct Supabase coordination — the default backend."""

    async def submit_contribution(
        self, quorum_id: str, role_id: str, user_token: str,
        content: str, structured_fields: dict[str, str],
        participant_id: str | None = None,
    ) -> dict[str, Any]:
        db = get_supabase()
        contribution_id = str(uuid.uuid4())
        row: dict[str, Any] = {
            "id": contribution_id,
            "quorum_id": quorum_id,
            "role_id": role_id,
            "user_token": user_token,
            "content": content,
            "structured_fields": structured_fields,
            "tier_processed": 1,
        }
        if participant_id is not None:
            row["participant_id"] = participant_id
        # 12.6: every Supabase call bounces through aexec.
        await aexec(db.table("contributions").insert(row))
        return row

    async def get_contributions(self, quorum_id: str) -> list[dict[str, Any]]:
        db = get_supabase()
        result = await aexec(
            db.table("contributions")
            .select("*")
            .eq("quorum_id", quorum_id)
            .order("created_at")
        )
        return result.data

    async def get_roles(self, quorum_id: str) -> list[dict[str, Any]]:
        db = get_supabase()
        result = await aexec(db.table("roles").select("*").eq("quorum_id", quorum_id))
        return result.data

    async def get_quorum(self, quorum_id: str) -> dict[str, Any] | None:
        db = get_supabase()
        result = await aexec(
            db.table("quorums").select("*").eq("id", quorum_id).maybe_single()
        )
        return result.data if result else None

    async def update_quorum_status(self, quorum_id: str, status: str) -> None:
        db = get_supabase()
        await aexec(
            db.table("quorums").update({"status": status}).eq("id", quorum_id)
        )

    async def store_synthesis(
        self, quorum_id: str, synthesis_data: dict[str, Any],
    ) -> None:
        db = get_supabase()
        await aexec(db.table("synthesis_snapshots").insert({
            "id": str(uuid.uuid4()),
            "quorum_id": quorum_id,
            **synthesis_data,
        }))
