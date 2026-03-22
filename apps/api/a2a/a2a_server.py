"""A2A server — FastAPI router for incoming A2A protocol requests."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..database import get_supabase
from .a2a_client import A2AClient

logger = logging.getLogger(__name__)

a2a_router = APIRouter(prefix="/a2a", tags=["a2a"])


@a2a_router.get("/")
async def a2a_root():
    """A2A discovery endpoint."""
    return {
        "protocol": "a2a",
        "version": "0.1.0",
        "name": "quorum-a2a",
        "description": "Quorum multi-agent coordination — A2A endpoint",
    }


# ---------------------------------------------------------------------------
# Architect Guidance
# ---------------------------------------------------------------------------

class GuidanceRequest(BaseModel):
    quorum_id: str
    message: str
    target_role_id: str | None = None


@a2a_router.post("/guidance")
async def post_guidance(body: GuidanceRequest) -> dict[str, Any]:
    """Send architect guidance — via A2A if target agent known, else Supabase fallback."""
    client = A2AClient()

    # Try A2A dispatch first if target_role_id specified
    if body.target_role_id:
        url = client.get_agent_url(body.target_role_id)
        if url:
            try:
                result = await client.send_message(
                    target_role_id=body.target_role_id,
                    message={
                        "type": "architect_guidance",
                        "quorum_id": body.quorum_id,
                        "message": body.message,
                    },
                )
                if result:
                    return {"status": "sent_a2a", "target_role_id": body.target_role_id}
            except Exception:
                logger.warning("A2A guidance dispatch failed, falling back to Supabase", exc_info=True)

    # Fallback: store in contributions table with special role_name
    db = get_supabase()
    row = {
        "id": str(uuid.uuid4()),
        "quorum_id": body.quorum_id,
        "role_id": body.target_role_id or "_architect",
        "user_token": "_architect",
        "content": body.message,
        "structured_fields": {"type": "architect_guidance"},
        "tier_processed": 0,
        "role_name": "_architect_guidance",
    }
    try:
        db.table("contributions").insert(row).execute()
    except Exception:
        logger.warning("Guidance Supabase insert failed", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to store guidance")

    return {"status": "stored_supabase", "contribution_id": row["id"]}


@a2a_router.get("/guidance/{quorum_id}")
async def get_guidance(quorum_id: str) -> dict[str, Any]:
    """Return recent architect guidance messages for a quorum."""
    db = get_supabase()
    result = (
        db.table("contributions")
        .select("id, content, created_at, role_id")
        .eq("quorum_id", quorum_id)
        .eq("user_token", "_architect")
        .order("created_at", desc=True)
        .limit(50)
        .execute()
    )
    return {"quorum_id": quorum_id, "messages": result.data}
