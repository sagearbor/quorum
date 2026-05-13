"""Persistent Pydantic AI MessageHistory store — checklist item 9.2.

Backs the ``conversations`` table introduced by
``supabase/migrations/20260513000001_conversations.sql``.  Each row holds
the serialised Pydantic AI message history for one
(quorum_id, role_id, participant_id) triple, and grows turn by turn as
``agent_engine`` calls ``save_history()`` after every successful run.

Design notes:

- We serialise via ``ModelMessagesTypeAdapter.dump_python(..., mode='json')``
  so the JSONB column round-trips losslessly (tool calls, usage, timestamps).
- ``participant_id = NULL`` is a first-class case — it represents the
  autonomous agent-to-agent conversation bucket (no human participant).
- Failures are LOGGED but never RAISED.  History is a context optimisation,
  not an invariant: if the load fails the agent runs without history; if the
  save fails the turn already produced a reply and the user gets it.  Both
  failure modes are strictly better than failing the turn.
- All writes go through the service-role Supabase client returned by
  ``apps.api.database.get_supabase`` — RLS locks INSERTs to service_role.

Decision (in-code, deliberate): MessageHistory AUGMENTS the existing
``agent_insights`` + ``station_messages`` context system rather than
replacing it.  The two cover different layers:

- ``station_messages`` is the human-facing transcript that drives the
  ``/agent/[roleId]`` UI and is rendered to the audience on the projector.
  Its schema (role / content / tags / metadata) is tightly coupled to the
  dashboards and we do NOT want to swap it for opaque Pydantic AI blobs.
- ``agent_insights`` is the cross-station signal lake used for tag-affinity
  routing of insights/A2A.  Also stays.
- ``conversations`` is the LLM-internal state — the Pydantic AI messages
  the model itself produced and consumed.  This is what lets the agent
  remember its own tool calls, reasoning style, and persona across turns
  without us hand-crafting that context every time.

So all three coexist and feed different downstream consumers.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _serialise(messages: list) -> list[dict]:
    """Convert Pydantic AI ``list[ModelMessage]`` → JSON-safe list of dicts.

    Lives in ``quorum_llm.providers._pai_common.serialise_messages`` so the
    serialisation logic stays next to the deserialisation logic.  Imported
    lazily so this module can be imported in environments that don't have
    Pydantic AI installed (e.g. typing-only contexts).
    """
    if not messages:
        return []
    from quorum_llm.providers._pai_common import serialise_messages

    return serialise_messages(messages)


def _deserialise(raw: Any) -> list:
    """Convert a JSONB column value → ``list[ModelMessage]``.

    Accepts None (no row / empty column), a list (already-parsed JSONB
    from Supabase), or a string (JSON-as-TEXT from the SQLite client).
    Returns an empty list on any parse failure — see file-level docstring.
    """
    if raw is None:
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("conversation_store: malformed JSON in messages column")
            return []
    if not raw:
        return []
    try:
        from quorum_llm.providers._pai_common import deserialise_messages

        return deserialise_messages(raw)
    except Exception:  # noqa: BLE001 — never let history corruption break a turn
        logger.warning(
            "conversation_store: failed to deserialise message history; "
            "falling back to empty history",
            exc_info=True,
        )
        return []


def _filter(query, key: str, value):
    """Apply an ``eq`` or ``is_('null')`` filter as appropriate.

    Supabase's PostgREST client uses ``.is_('null')`` for NULL comparisons,
    while ``.eq('col', None)`` produces ``col=eq.None`` which doesn't match
    NULL rows.  This helper papers over that ergonomic wart.
    """
    if value is None:
        # ``.is_(key, 'null')`` is the supabase-py form; SQLite client mirrors it.
        return query.is_(key, "null")
    return query.eq(key, value)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def load_history(
    db,
    quorum_id: str,
    role_id: str,
    participant_id: str | None = None,
) -> list:
    """Load persisted Pydantic AI message history for one (quorum, role, participant).

    Returns an empty list when no row exists (or on any error) — callers can
    safely pass the result straight to ``Agent.run(message_history=...)``
    without a None check.
    """
    try:
        query = db.table("conversations").select("messages").eq("quorum_id", quorum_id).eq(
            "role_id", role_id
        )
        query = _filter(query, "participant_id", participant_id)
        result = query.maybe_single().execute()
    except Exception:
        logger.warning(
            "conversation_store.load_history: query failed for quorum=%s role=%s",
            quorum_id,
            role_id,
            exc_info=True,
        )
        return []

    if not result or not getattr(result, "data", None):
        return []
    return _deserialise(result.data.get("messages"))


def save_history(
    db,
    quorum_id: str,
    role_id: str,
    new_messages: list,
    participant_id: str | None = None,
) -> None:
    """Append ``new_messages`` to the persisted history for the (quorum, role, participant).

    If a row exists, it is upserted with ``existing_messages + new_messages``
    and ``updated_at = now()``.  If no row exists yet, one is inserted with
    ``new_messages`` as the seed.

    The function is async-safe to call from an awaited agent turn but is
    itself synchronous because the Supabase Python client is sync.  It NEVER
    raises — see file-level docstring.

    Args:
        db: Supabase client (service-role).
        quorum_id: Quorum UUID.
        role_id: Role UUID.
        new_messages: Pydantic AI ``list[ModelMessage]`` delta from the run.
        participant_id: Optional participant UUID; NULL for autonomous turns.
    """
    if not new_messages:
        # Nothing to persist — avoid a redundant write that would still flip
        # updated_at and trigger unnecessary realtime notifications.
        return

    try:
        new_serialised = _serialise(new_messages)
    except Exception:  # noqa: BLE001
        logger.warning(
            "conversation_store.save_history: serialisation failed for quorum=%s role=%s",
            quorum_id,
            role_id,
            exc_info=True,
        )
        return

    # Try to load the existing row first so we can append.  Most agent turns
    # already loaded history via ``load_history`` upstream, but we re-query
    # here because (a) the caller may have a stale snapshot and (b) we want
    # this helper to be self-contained / safely usable in isolation.
    existing_serialised: list[dict] = []
    existing_id: str | None = None
    try:
        query = db.table("conversations").select("id, messages").eq(
            "quorum_id", quorum_id
        ).eq("role_id", role_id)
        query = _filter(query, "participant_id", participant_id)
        existing = query.maybe_single().execute()
        if existing and getattr(existing, "data", None):
            existing_id = existing.data.get("id")
            raw = existing.data.get("messages")
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except json.JSONDecodeError:
                    raw = []
            if isinstance(raw, list):
                existing_serialised = raw
    except Exception:
        logger.warning(
            "conversation_store.save_history: failed to load existing row; "
            "will INSERT a fresh row instead of UPSERT",
            exc_info=True,
        )

    combined = existing_serialised + new_serialised

    now = _now_iso()
    if existing_id:
        # UPDATE path — preserve the row's PK, just bump messages + updated_at.
        try:
            db.table("conversations").update(
                {"messages": combined, "updated_at": now}
            ).eq("id", existing_id).execute()
        except Exception:
            logger.warning(
                "conversation_store.save_history: UPDATE failed for row id=%s",
                existing_id,
                exc_info=True,
            )
        return

    # INSERT path — no prior row.  We let the DB generate the id when the
    # client supports it; otherwise we supply a uuid4 so SQLite (which does
    # NOT default-generate UUIDs) still gets a non-NULL PK.
    row = {
        "id": str(uuid.uuid4()),
        "quorum_id": quorum_id,
        "role_id": role_id,
        "participant_id": participant_id,
        "messages": combined,
        "created_at": now,
        "updated_at": now,
    }
    try:
        db.table("conversations").insert(row).execute()
    except Exception:
        logger.warning(
            "conversation_store.save_history: INSERT failed for quorum=%s role=%s",
            quorum_id,
            role_id,
            exc_info=True,
        )
