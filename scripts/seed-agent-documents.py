#!/usr/bin/env python3
"""
seed-agent-documents.py — Load pre-seeded agent documents into Supabase.

Reads seed/clinical-trial-documents.json and inserts each document into the
agent_documents table for the target quorum.  Idempotent: if a document with
the same title already exists for that quorum, it is skipped (not replaced).

Usage:
    python scripts/seed-agent-documents.py
    python scripts/seed-agent-documents.py --quorum-id <uuid>
    python scripts/seed-agent-documents.py --dry-run

Environment variables required (or loaded from .env):
    SUPABASE_URL
    SUPABASE_SERVICE_KEY   (service role key — bypasses RLS)

Exit codes:
    0  All documents inserted (or skipped as duplicates)
    1  Fatal error (missing env vars, Supabase unreachable, schema mismatch)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import uuid
from pathlib import Path

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_env_file(env_path: Path) -> None:
    """Read a .env file and inject variables into os.environ (skip if absent)."""
    if not env_path.exists():
        return
    with env_path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def get_supabase_client():
    """Return an authenticated Supabase client using the service role key."""
    try:
        from supabase import create_client, Client  # type: ignore
    except ImportError:
        logger.error(
            "supabase-py is not installed. "
            "Run: pip install supabase"
        )
        sys.exit(1)

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")

    if not url:
        logger.error("SUPABASE_URL environment variable is not set.")
        sys.exit(1)
    if not key:
        logger.error(
            "SUPABASE_SERVICE_KEY is not set. "
            "The service role key is required to bypass RLS on agent_documents."
        )
        sys.exit(1)

    return create_client(url, key)


def load_seed_file(repo_root: Path) -> dict:
    """Read and parse the seed document JSON."""
    seed_path = repo_root / "seed" / "clinical-trial-documents.json"
    if not seed_path.exists():
        logger.error("Seed file not found: %s", seed_path)
        sys.exit(1)
    with seed_path.open() as fh:
        return json.load(fh)


def resolve_quorum_id(db, seed_data: dict, override: str | None) -> str:
    """
    Return the quorum ID to use for seeding.

    Priority:
    1. --quorum-id CLI argument
    2. quorum_id field in the seed file
    3. First 'active' quorum found in Supabase matching the seed event
    """
    if override:
        logger.info("Using quorum ID from --quorum-id flag: %s", override)
        return override

    seed_quorum_id = seed_data.get("quorum_id")
    if seed_quorum_id:
        logger.info("Using quorum ID from seed file: %s", seed_quorum_id)
        return seed_quorum_id

    # Fall back: find the first active quorum in the seed event
    seed_event_id = "00000000-0000-0000-0000-000000000001"
    result = (
        db.table("quorums")
        .select("id, title, status")
        .eq("event_id", seed_event_id)
        .in_("status", ["open", "active"])
        .limit(1)
        .execute()
    )
    if result.data:
        qid = result.data[0]["id"]
        logger.info(
            "Resolved quorum ID from Supabase: %s (%s)",
            qid,
            result.data[0]["title"],
        )
        return qid

    logger.error(
        "Could not resolve quorum ID. "
        "Provide --quorum-id or ensure the seed event has an active quorum."
    )
    sys.exit(1)


def get_existing_titles(db, quorum_id: str) -> set[str]:
    """Return the set of document titles already seeded for this quorum."""
    result = (
        db.table("agent_documents")
        .select("title")
        .eq("quorum_id", quorum_id)
        .eq("status", "active")
        .execute()
    )
    return {row["title"] for row in result.data}


def build_document_row(quorum_id: str, doc: dict) -> dict:
    """Convert a seed document entry into an agent_documents table row."""
    return {
        "id": str(uuid.uuid4()),
        "quorum_id": quorum_id,
        "title": doc["title"],
        "doc_type": doc["doc_type"],
        # The migration defines doc_format as an enum: json|yaml|csv|markdown.
        # All seed docs use 'json' content envelope regardless of the conceptual
        # format (e.g., the Budget Analysis is stored as structured JSON even
        # though its logical format is tabular/CSV).
        "format": "json",
        "content": doc["content"],
        "status": doc["status"],
        "version": 1,
        "tags": doc.get("tags", []),
        # No created_by_role_id for seed documents — they are architect-seeded
        "created_by_role_id": None,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--quorum-id",
        default=None,
        help="Override the quorum ID to seed documents into",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be inserted without writing to Supabase",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-insert documents even if they already exist (updates version)",
    )
    args = parser.parse_args()

    # Locate repo root (this script lives in scripts/ one level below root)
    repo_root = Path(__file__).resolve().parent.parent

    # Load .env if present (development convenience — not needed in CI)
    load_env_file(repo_root / ".env")
    load_env_file(repo_root / ".env.local")

    seed_data = load_seed_file(repo_root)

    if args.dry_run:
        logger.info("[DRY RUN] Would insert %d documents.", len(seed_data["documents"]))
        for doc in seed_data["documents"]:
            logger.info(
                "  - '%s' (type=%s, tags=%s)",
                doc["title"],
                doc["doc_type"],
                ", ".join(doc.get("tags", [])),
            )
        logger.info(
            "Problems embedded across documents:\n%s",
            "\n".join(
                f"  [{doc['title']}] {p}"
                for doc in seed_data["documents"]
                for p in doc["content"]["metadata"]["problems"]
            ),
        )
        return

    db = get_supabase_client()
    quorum_id = resolve_quorum_id(db, seed_data, args.quorum_id)

    # Verify the target quorum actually exists
    quorum_check = (
        db.table("quorums").select("id, title").eq("id", quorum_id).execute()
    )
    if not quorum_check.data:
        logger.error("Quorum %s does not exist in Supabase.", quorum_id)
        sys.exit(1)

    logger.info(
        "Seeding documents into quorum: %s — '%s'",
        quorum_id,
        quorum_check.data[0]["title"],
    )

    existing = get_existing_titles(db, quorum_id)
    inserted = 0
    skipped = 0

    for doc in seed_data["documents"]:
        title = doc["title"]

        if title in existing and not args.force:
            logger.info("  SKIP (already exists): '%s'", title)
            skipped += 1
            continue

        row = build_document_row(quorum_id, doc)

        if title in existing and args.force:
            # Upsert: delete old version first so we get a clean insert
            # (agent_documents has no unique constraint on title+quorum, so
            #  we soft-delete then insert to avoid duplicates)
            db.table("agent_documents").update({"status": "superseded"}).eq(
                "quorum_id", quorum_id
            ).eq("title", title).eq("status", "active").execute()
            logger.info("  REPLACE (--force): '%s'", title)

        result = db.table("agent_documents").insert(row).execute()

        if result.data:
            logger.info(
                "  INSERTED: '%s' (id=%s, type=%s, tags=%s)",
                title,
                result.data[0]["id"],
                doc["doc_type"],
                ", ".join(doc.get("tags", [])),
            )
            inserted += 1
        else:
            logger.warning("  FAILED to insert '%s' — no data returned", title)

    logger.info(
        "Done. %d inserted, %d skipped.",
        inserted,
        skipped,
    )

    # Summarise all embedded problems for operator visibility
    if inserted > 0:
        print("\n--- Problems seeded for agents to resolve ---")
        for doc in seed_data["documents"]:
            problems = doc["content"]["metadata"].get("problems", [])
            if problems:
                print(f"\n[{doc['title']}]")
                for p in problems:
                    print(f"  * {p}")
        print()


if __name__ == "__main__":
    main()
