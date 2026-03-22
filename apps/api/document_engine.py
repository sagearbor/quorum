"""Document engine — CAS writes, change logging, and oscillation detection.

All document mutations go through this module so the change log stays
consistent and oscillation checks fire on every write.

Design notes:
- CAS is implemented by matching on both `id` AND `version`.  If the
  Supabase update returns no rows the version guard fired — we return the
  current document so callers can decide what to do (retry, merge, etc.).
- Oscillation is detected by scanning the last 10 changes to a document and
  looking for an A→B→A→B value pattern on any individual JSON field path.
- This module deliberately has no FastAPI / Starlette imports; it is pure
  business logic and can be tested without an HTTP stack.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

# Number of past changes to inspect when checking for oscillation.
_OSCILLATION_WINDOW = 10
# Minimum oscillation cycles before we emit an event and escalate.
_OSCILLATION_THRESHOLD = 2


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def create_document(
    quorum_id: str,
    doc_data: dict[str, Any],
    supabase,
) -> dict[str, Any]:
    """Create a new agent document.

    Args:
        quorum_id: Parent quorum UUID.
        doc_data: Keys: title, doc_type, format, content, tags,
                  created_by_role_id (optional).
        supabase: Supabase client.

    Returns:
        The newly created document row as a dict.

    Raises:
        ValueError: If required fields are missing.
        RuntimeError: If the DB insert fails.
    """
    required = ("title", "doc_type", "content")
    for field in required:
        if field not in doc_data:
            raise ValueError(f"Missing required document field: {field}")

    doc_id = str(uuid.uuid4())
    now = _now_iso()
    row = {
        "id": doc_id,
        "quorum_id": quorum_id,
        "title": doc_data["title"],
        "doc_type": doc_data["doc_type"],
        "format": doc_data.get("format", "json"),
        "content": doc_data["content"],
        "status": "active",
        "version": 1,
        "tags": doc_data.get("tags", []),
        "created_by_role_id": doc_data.get("created_by_role_id"),
        "created_at": now,
        "updated_at": now,
    }

    result = supabase.table("agent_documents").insert(row).execute()
    if not result.data:
        raise RuntimeError(f"Failed to create document for quorum {quorum_id}")

    created = result.data[0]

    # Log the creation event
    _log_change(
        supabase=supabase,
        document_id=doc_id,
        version=1,
        changed_by_role=doc_data.get("created_by_role_id", "system"),
        change_type="create",
        diff={"op": "create", "content": doc_data["content"]},
        rationale="Document created",
        previous_content=None,
        tags=doc_data.get("tags", []),
    )

    return created


async def update_document(
    doc_id: str,
    changes: dict[str, Any],
    role_id: str,
    rationale: str,
    supabase,
) -> dict[str, Any]:
    """CAS update a document.

    Args:
        doc_id: Document UUID.
        changes: Must include ``content`` (new full content) and
                 ``expected_version`` (integer for CAS guard).
        role_id: Role performing the edit.
        rationale: Agent's stated reason for the change.
        supabase: Supabase client.

    Returns:
        Dict with keys ``version`` (int) and ``merged`` (bool).
        ``merged=True`` means the CAS guard fired and we returned the
        current state rather than writing (caller should re-read + retry).

    Raises:
        ValueError: If required keys are missing from ``changes``.
        RuntimeError: If the document does not exist.
    """
    if "content" not in changes:
        raise ValueError("update_document: 'content' is required")
    if "expected_version" not in changes:
        raise ValueError("update_document: 'expected_version' is required")

    new_content: dict = changes["content"]
    expected_version: int = int(changes["expected_version"])

    # Fetch current document (needed for diff and fallback return)
    current_result = (
        supabase.table("agent_documents")
        .select("*")
        .eq("id", doc_id)
        .single()
        .execute()
    )
    if not current_result.data:
        raise RuntimeError(f"Document {doc_id} not found")

    current = current_result.data
    previous_content = current["content"]
    current_version: int = current["version"]

    # CAS: attempt update only if version matches
    new_version = expected_version + 1
    update_result = (
        supabase.table("agent_documents")
        .update({
            "content": new_content,
            "version": new_version,
            "updated_at": _now_iso(),
        })
        .eq("id", doc_id)
        .eq("version", expected_version)  # CAS guard
        .execute()
    )

    if not update_result.data:
        # CAS failed — another agent edited concurrently.
        # Return current state so the caller can decide whether to merge.
        logger.info(
            "document_engine: CAS conflict on doc %s (expected v%d, actual v%d)",
            doc_id, expected_version, current_version,
        )
        return {"version": current_version, "merged": True}

    # Log the change
    diff = _compute_diff(previous_content, new_content)
    _log_change(
        supabase=supabase,
        document_id=doc_id,
        version=new_version,
        changed_by_role=role_id,
        change_type="edit",
        diff=diff,
        rationale=rationale,
        previous_content=previous_content,
        tags=current.get("tags", []),
    )

    # Check for oscillation after every write
    oscillating = await detect_oscillation(doc_id, supabase)
    if oscillating:
        logger.warning(
            "document_engine: oscillation detected on doc %s after edit by role %s",
            doc_id, role_id,
        )
        # Escalation is recorded inside detect_oscillation when it fires.

    return {"version": new_version, "merged": False}


async def detect_oscillation(doc_id: str, supabase) -> bool:
    """Check the change log for an A→B→A→B flip pattern.

    Looks at the last ``_OSCILLATION_WINDOW`` changes.  For each flat JSON
    field path that appears in multiple diffs, it checks whether the sequence
    of values alternates (i.e., cycles between two or more distinct values).

    Returns:
        True if oscillation was detected (and an oscillation_event row was
        inserted).  False otherwise.
    """
    try:
        result = (
            supabase.table("document_changes")
            .select("diff, changed_by_role, version, tags")
            .eq("document_id", doc_id)
            .order("version", desc=True)
            .limit(_OSCILLATION_WINDOW)
            .execute()
        )
        changes = result.data or []
    except Exception:
        logger.warning("document_engine: failed to load changes for oscillation check", exc_info=True)
        return False

    if len(changes) < _OSCILLATION_THRESHOLD * 2:
        return False

    # Collect field-path → list[(role, value)] sequences
    field_sequences: dict[str, list[tuple[str, Any]]] = {}
    # Changes are returned newest-first; reverse to get chronological order
    for change in reversed(changes):
        diff = change.get("diff") or {}
        role = change.get("changed_by_role", "unknown")
        for path, value in _flatten_diff(diff):
            field_sequences.setdefault(path, []).append((role, value))

    oscillation_found = False
    for field_path, sequence in field_sequences.items():
        if len(sequence) < _OSCILLATION_THRESHOLD * 2:
            continue

        values = [v for _, v in sequence]
        cycle_count = _count_oscillation_cycles(values)
        if cycle_count >= _OSCILLATION_THRESHOLD:
            involved_roles = list({r for r, _ in sequence})
            logger.warning(
                "document_engine: oscillation on doc %s field '%s' (%d cycles, roles: %s)",
                doc_id, field_path, cycle_count, involved_roles,
            )
            _record_oscillation_event(
                supabase=supabase,
                doc_id=doc_id,
                field_path=field_path,
                cycle_count=cycle_count,
                involved_roles=involved_roles,
                values_sequence=values,
            )
            oscillation_found = True

    return oscillation_found


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _log_change(
    supabase,
    document_id: str,
    version: int,
    changed_by_role: str | None,
    change_type: str,
    diff: dict,
    rationale: str | None,
    previous_content: dict | None,
    tags: list[str],
) -> None:
    """Append a row to document_changes. Errors are swallowed."""
    try:
        supabase.table("document_changes").insert({
            "id": str(uuid.uuid4()),
            "document_id": document_id,
            "version": version,
            "changed_by_role": changed_by_role or "system",
            "change_type": change_type,
            "diff": diff,
            "rationale": rationale,
            "previous_content": previous_content,
            "tags": tags,
            "created_at": _now_iso(),
        }).execute()
    except Exception:
        logger.warning(
            "document_engine: failed to log change for doc %s v%d",
            document_id, version, exc_info=True,
        )


def _compute_diff(old: dict, new: dict) -> dict:
    """Produce a simple field-level diff between two JSON objects.

    Returns a dict of {field_path: {"from": old_value, "to": new_value}}
    for top-level keys that changed.  Nested diffs are not yet supported;
    nested changes are captured by including the whole subtree.
    """
    diff: dict[str, Any] = {}
    all_keys = set(old.keys()) | set(new.keys())
    for key in all_keys:
        old_val = old.get(key)
        new_val = new.get(key)
        if old_val != new_val:
            diff[key] = {"from": old_val, "to": new_val}
    return diff


def _flatten_diff(diff: dict) -> list[tuple[str, Any]]:
    """Extract (field_path, new_value) pairs from a diff dict.

    Works with diffs produced by _compute_diff (top-level keys only).
    """
    pairs: list[tuple[str, Any]] = []
    for key, change in diff.items():
        if isinstance(change, dict) and "to" in change:
            pairs.append((key, change["to"]))
        elif key not in ("op",):  # skip meta-fields like "op": "create"
            pairs.append((key, change))
    return pairs


def _count_oscillation_cycles(values: list[Any]) -> int:
    """Count how many full A→B→A cycles exist in the value sequence.

    A cycle is defined as: value at position i equals value at position i-2
    AND differs from position i-1 (i.e., the value flipped back).
    """
    if len(values) < 3:
        return 0

    cycles = 0
    for i in range(2, len(values)):
        if values[i] == values[i - 2] and values[i] != values[i - 1]:
            cycles += 1

    return cycles


def _record_oscillation_event(
    supabase,
    doc_id: str,
    field_path: str,
    cycle_count: int,
    involved_roles: list[str],
    values_sequence: list[Any],
) -> None:
    """Insert an oscillation_events row and attempt escalation.

    Escalation: find the highest-authority role in the quorum that is NOT
    involved in the oscillation and create an A2A escalation request.
    If no uninvolved role exists, we log a warning (architect notification
    via WebSocket is a future enhancement).
    """
    try:
        # Look up quorum_id from the document
        doc_result = (
            supabase.table("agent_documents")
            .select("quorum_id")
            .eq("id", doc_id)
            .single()
            .execute()
        )
        quorum_id = (doc_result.data or {}).get("quorum_id", "unknown")

        supabase.table("oscillation_events").insert({
            "id": str(uuid.uuid4()),
            "document_id": doc_id,
            "quorum_id": quorum_id,
            "field_path": field_path,
            "cycle_count": cycle_count,
            "involved_roles": involved_roles,
            "values_sequence": values_sequence,
            "escalated": False,
            "created_at": _now_iso(),
        }).execute()

        # Attempt escalation to highest-authority uninvolved role
        if quorum_id != "unknown":
            _escalate_oscillation(
                supabase=supabase,
                quorum_id=quorum_id,
                doc_id=doc_id,
                field_path=field_path,
                involved_roles=involved_roles,
                cycle_count=cycle_count,
            )

    except Exception:
        logger.warning(
            "document_engine: failed to record oscillation event for doc %s",
            doc_id, exc_info=True,
        )


def _escalate_oscillation(
    supabase,
    quorum_id: str,
    doc_id: str,
    field_path: str,
    involved_roles: list[str],
    cycle_count: int,
) -> None:
    """Create an A2A escalation request to the highest-authority uninvolved role."""
    try:
        all_roles = (
            supabase.table("roles")
            .select("id, name, authority_rank")
            .eq("quorum_id", quorum_id)
            .order("authority_rank", desc=True)
            .execute()
        )
        roles = all_roles.data or []

        # Pick the highest-authority role NOT involved in the oscillation
        escalation_target = None
        for role in roles:
            if role["id"] not in involved_roles:
                escalation_target = role
                break

        if not escalation_target:
            logger.warning(
                "document_engine: all roles involved in oscillation on doc %s — "
                "cannot escalate automatically (notify architect)",
                doc_id,
            )
            return

        # Use any involved role as the "from" for the escalation request
        from_role_id = involved_roles[0] if involved_roles else (roles[0]["id"] if roles else "system")

        supabase.table("agent_requests").insert({
            "id": str(uuid.uuid4()),
            "quorum_id": quorum_id,
            "from_role_id": from_role_id,
            "to_role_id": escalation_target["id"],
            "request_type": "escalation",
            "content": (
                f"Oscillation detected on document (field: '{field_path}'). "
                f"{cycle_count} full A→B→A cycles were recorded. "
                f"Roles involved: {involved_roles}. "
                "Please review the document and make a ruling on the correct value."
            ),
            "tags": ["oscillation", "escalation"],
            "document_id": doc_id,
            "status": "pending",
            "priority": 4,  # Critical
            "created_at": _now_iso(),
        }).execute()

        # Mark oscillation event as escalated
        supabase.table("oscillation_events").update({"escalated": True}).eq(
            "document_id", doc_id
        ).eq("field_path", field_path).execute()

    except Exception:
        logger.warning(
            "document_engine: escalation attempt failed for doc %s",
            doc_id, exc_info=True,
        )
