#!/usr/bin/env python3
"""Clean up old events and quorums via the Quorum API.

Usage:
    python scripts/cleanup.py --list
    python scripts/cleanup.py --delete-event <slug> --confirm
    python scripts/cleanup.py --archive-older-than 7d
    python scripts/cleanup.py --archive-event <slug>
    python scripts/cleanup.py --archive-quorum <quorum-id>

Environment variables:
    QUORUM_API_URL  Base URL for the API (default: http://localhost:8000)
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone

try:
    import requests
except ImportError:
    print("Error: 'requests' package not installed. Run: pip install requests")
    sys.exit(1)

API_BASE = os.environ.get("QUORUM_API_URL", "http://localhost:8000")


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

def api_get(path: str) -> list | dict:
    url = f"{API_BASE}{path}"
    res = requests.get(url, timeout=15)
    res.raise_for_status()
    return res.json()


def api_patch(path: str) -> dict:
    url = f"{API_BASE}{path}"
    res = requests.patch(url, timeout=15)
    res.raise_for_status()
    return res.json()


def api_delete(path: str, confirm: bool = True) -> None:
    params = {"confirm": "true"} if confirm else {}
    url = f"{API_BASE}{path}"
    res = requests.delete(url, params=params, timeout=15)
    res.raise_for_status()


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_list() -> None:
    """Print all events with their quorums and created_at timestamps."""
    events = api_get("/events")
    if not events:
        print("No events found.")
        return

    print(f"{'SLUG':<30} {'NAME':<30} {'CREATED':<20} {'QUORUMS'}")
    print("-" * 90)
    for event in events:
        event_id = event["id"]
        slug = event["slug"]
        name = event["name"]
        created_at = event.get("created_at", "")[:10]

        # Fetch quorums for this event
        try:
            quorums = api_get(f"/events/{event_id}/quorums")
            quorum_count = len(quorums)
        except Exception:
            quorum_count = "?"

        print(f"{slug:<30} {name:<30} {created_at:<20} {quorum_count}")


def cmd_archive_event(slug: str) -> None:
    """Archive (soft-delete) an event by slug."""
    events = api_get("/events")
    match = next((e for e in events if e["slug"] == slug), None)
    if not match:
        print(f"Error: no event with slug '{slug}'")
        sys.exit(1)

    event_id = match["id"]
    result = api_patch(f"/events/{event_id}/archive")
    print(f"Archived event '{slug}' (id={event_id}): {result}")


def cmd_archive_quorum(quorum_id: str) -> None:
    """Archive (soft-delete) a quorum by ID."""
    result = api_patch(f"/quorums/{quorum_id}/archive")
    print(f"Archived quorum {quorum_id}: {result}")


def cmd_delete_event(slug: str) -> None:
    """Hard-delete an event after confirmation.  The event must be archived first."""
    events = api_get("/events")
    match = next((e for e in events if e["slug"] == slug), None)
    if not match:
        print(f"Error: no event with slug '{slug}'")
        sys.exit(1)

    event_id = match["id"]
    status = match.get("status", "")
    if status != "archived":
        print(
            f"Warning: event '{slug}' is not archived (status={status!r}). "
            "Archive it first with --archive-event."
        )
        print("Proceeding with delete anyway (--confirm was passed).")

    api_delete(f"/events/{event_id}", confirm=True)
    print(f"Permanently deleted event '{slug}' (id={event_id}).")


def cmd_archive_older_than(duration_str: str) -> None:
    """Archive all events (and their quorums) older than the given duration.

    Duration format: <N>d for days, <N>h for hours.
    Example: '7d' archives everything older than 7 days.
    """
    # Parse duration
    duration_str = duration_str.strip().lower()
    if duration_str.endswith("d"):
        delta = timedelta(days=int(duration_str[:-1]))
    elif duration_str.endswith("h"):
        delta = timedelta(hours=int(duration_str[:-1]))
    else:
        print(f"Error: unrecognized duration '{duration_str}'. Use e.g. '7d' or '24h'.")
        sys.exit(1)

    cutoff = datetime.now(timezone.utc) - delta
    events = api_get("/events")
    archived_events = 0
    archived_quorums = 0

    for event in events:
        created_str = event.get("created_at", "")
        if not created_str:
            continue
        # Parse ISO timestamp (strip trailing Z or offset for fromisoformat compat)
        created_at = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
        if created_at >= cutoff:
            continue

        # Archive event
        try:
            api_patch(f"/events/{event['id']}/archive")
            print(f"Archived event '{event['slug']}' (created {created_str[:10]})")
            archived_events += 1
        except Exception as exc:
            print(f"  Warning: could not archive event {event['slug']}: {exc}")

        # Archive all quorums under this event
        try:
            quorums = api_get(f"/events/{event['id']}/quorums")
            for quorum in quorums:
                if quorum.get("status") == "archived":
                    continue
                try:
                    api_patch(f"/quorums/{quorum['id']}/archive")
                    print(f"  Archived quorum '{quorum['title']}'")
                    archived_quorums += 1
                except Exception as exc2:
                    print(f"  Warning: could not archive quorum {quorum['id']}: {exc2}")
        except Exception as exc:
            print(f"  Warning: could not fetch quorums for {event['slug']}: {exc}")

    print(f"\nDone. Archived {archived_events} event(s) and {archived_quorums} quorum(s).")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Quorum cleanup CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list", action="store_true", help="List all events")
    group.add_argument("--archive-event", metavar="SLUG", help="Archive an event by slug")
    group.add_argument("--archive-quorum", metavar="ID", help="Archive a quorum by ID")
    group.add_argument(
        "--delete-event",
        metavar="SLUG",
        help="Permanently delete an archived event (requires --confirm)",
    )
    group.add_argument(
        "--archive-older-than",
        metavar="DURATION",
        help="Archive all events older than DURATION (e.g. 7d, 24h)",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Confirm destructive operations (required for --delete-event)",
    )

    args = parser.parse_args()

    if args.list:
        cmd_list()
    elif args.archive_event:
        cmd_archive_event(args.archive_event)
    elif args.archive_quorum:
        cmd_archive_quorum(args.archive_quorum)
    elif args.delete_event:
        if not args.confirm:
            print("Error: --delete-event requires --confirm to prevent accidental deletion.")
            sys.exit(1)
        cmd_delete_event(args.delete_event)
    elif args.archive_older_than:
        cmd_archive_older_than(args.archive_older_than)


if __name__ == "__main__":
    main()
