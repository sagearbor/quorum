"""Seed loader — loads clinical-trial.json into Supabase on FastAPI startup.

Idempotent: checks if the seed event already exists before inserting.
Skips entirely if SUPABASE_URL is not set (demo/offline mode).
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

SEED_FILE = Path(__file__).resolve().parent.parent.parent / "seed" / "clinical-trial.json"

# Fixed IDs from the seed file — used for idempotency checks
SEED_EVENT_ID = "00000000-0000-0000-0000-000000000001"


def _load_seed_data() -> dict:
    """Read and parse the seed JSON file."""
    with open(SEED_FILE) as f:
        return json.load(f)


async def load_seed_quorum() -> None:
    """Load the seed quorum into Supabase if it doesn't already exist.

    Called from FastAPI startup. Idempotent — safe to call on every boot.
    """
    # Skip if no Supabase configured (pure offline mode)
    if not os.environ.get("SUPABASE_URL"):
        logger.info("SUPABASE_URL not set — skipping seed loader (offline mode)")
        return

    if not SEED_FILE.exists():
        logger.warning("Seed file not found at %s — skipping", SEED_FILE)
        return

    from database import get_supabase

    db = get_supabase()

    # Idempotency check: does the seed event already exist?
    existing = db.table("events").select("id").eq("id", SEED_EVENT_ID).execute()
    if existing.data:
        logger.info("Seed event %s already exists — skipping", SEED_EVENT_ID)
        return

    logger.info("Loading seed data from %s", SEED_FILE)
    seed = _load_seed_data()

    # 1. Insert event
    event = seed["event"]
    db.table("events").insert({
        "id": event["id"],
        "name": event["name"],
        "slug": event["slug"],
        "access_code": event["access_code"],
        "max_active_quorums": event["max_active_quorums"],
        "created_by": event["created_by"],
    }).execute()
    logger.info("Created seed event: %s (%s)", event["name"], event["slug"])

    # 2. Insert quorums, roles, contributions, artifacts
    for quorum in seed["quorums"]:
        db.table("quorums").insert({
            "id": quorum["id"],
            "event_id": quorum["event_id"],
            "title": quorum["title"],
            "description": quorum["description"],
            "status": quorum["status"],
            "heat_score": quorum["heat_score"],
            "dashboard_types": quorum["dashboard_types"],
            "carousel_mode": quorum["carousel_mode"],
        }).execute()
        logger.info("Created seed quorum: %s", quorum["title"])

        # Insert roles
        for role in quorum["roles"]:
            db.table("roles").insert({
                "id": role["id"],
                "quorum_id": quorum["id"],
                "name": role["name"],
                "capacity": str(role["capacity"]),
                "authority_rank": role["authority_rank"],
                "prompt_template": role["prompt_template"],
                "fallback_chain": role["fallback_chain"],
                "color": role["color"],
            }).execute()

        # Insert contributions
        for contrib in quorum.get("contributions", []):
            db.table("contributions").insert({
                "id": contrib["id"],
                "quorum_id": quorum["id"],
                "role_id": contrib["role_id"],
                "user_token": contrib["user_token"],
                "content": contrib["content"],
                "structured_fields": contrib["structured_fields"],
                "tier_processed": contrib["tier_processed"],
            }).execute()

        # Insert artifact
        artifact = quorum.get("artifact")
        if artifact:
            db.table("artifacts").insert({
                "id": artifact["id"],
                "quorum_id": quorum["id"],
                "version": artifact["version"],
                "content_hash": artifact["content_hash"],
                "sections": artifact["sections"],
                "status": artifact["status"],
            }).execute()
            logger.info("Created seed artifact for quorum: %s", quorum["title"])

    logger.info("Seed data loaded successfully")
