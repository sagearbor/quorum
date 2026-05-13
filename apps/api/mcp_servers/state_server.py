"""``mcp_state`` — MCP server wrapping the quorum blackboard state.

Tool surface
------------
- ``get_quorum_state(quorum_id) -> dict``
- ``propose(quorum_id, field, content, proposed_by_role_id) -> {proposal_id}``
- ``support_proposal(quorum_id, proposal_id, role_id) -> {ok}``
- ``block_proposal(quorum_id, proposal_id, role_id) -> {ok}``
- ``raise_question(quorum_id, text, raised_by_role_id, tags) -> {question_id}``

Deferred wiring (TODO 11.6 re-integration)
------------------------------------------
The dedicated ``quorum_state`` blackboard module (proposals/support/block,
questions, structured fields with version+CAS) is being delivered by
checklist item 11.6 in a parallel branch.  At the time this server was
written that PR had not landed, so the state server uses a *resilient
shim* that:

1. For ``get_quorum_state``: reads the most recent row from
   ``quorum_state_snapshots`` if present, else assembles a best-effort
   state document from existing tables (``quorums``, ``contributions``,
   ``roles``).  When 11.6 lands the implementation should switch to
   the canonical ``quorum_state`` table that PR introduces.

2. For ``propose`` / ``support_proposal`` / ``block_proposal`` /
   ``raise_question``: writes to ``quorum_state_snapshots`` (which exists
   on every backend today) as a JSON envelope with an explicit
   ``__shim__: "11.6-pending"`` marker so downstream readers know to
   migrate. The tool returns a generated UUID so callers' contracts
   are stable across the migration.

When 11.6 merges, replace the shim helpers (``_state_get``,
``_state_write_envelope``) with direct calls into the new
``quorum_state`` module without changing this file's tool signatures.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError


# ---------------------------------------------------------------------------
# Shim helpers — see TODO block at top of file.
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _state_get(db: Any, quorum_id: str) -> dict[str, Any]:
    """Best-effort read of the canonical quorum state for ``quorum_id``.

    Order of preference:
    1. Latest ``quorum_state_snapshots`` row (if present).
    2. Synthesised document from ``quorums`` + ``roles`` + ``contributions``.
    """
    try:
        snapshots = (
            db.table("quorum_state_snapshots")
            .select("*")
            .eq("quorum_id", quorum_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
    except Exception:
        snapshots = None

    if snapshots is not None and getattr(snapshots, "data", None):
        row = snapshots.data[0]
        snap = row.get("snapshot")
        if isinstance(snap, str):
            try:
                snap = json.loads(snap)
            except (TypeError, ValueError):
                snap = {"_raw": snap}
        if isinstance(snap, dict):
            snap.setdefault("quorum_id", quorum_id)
            return snap

    # Fall back: synthesise from primary tables.
    quorum_q = db.table("quorums").select("*").eq("id", quorum_id).execute()
    if not getattr(quorum_q, "data", None):
        raise ToolError(f"Quorum {quorum_id!r} not found")

    roles_q = db.table("roles").select("*").eq("quorum_id", quorum_id).execute()
    contribs_q = (
        db.table("contributions")
        .select("*")
        .eq("quorum_id", quorum_id)
        .order("created_at")
        .execute()
    )

    return {
        "quorum_id": quorum_id,
        "quorum": quorum_q.data[0],
        "roles": list(roles_q.data or []),
        "contributions": list(contribs_q.data or []),
        "proposals": [],          # TODO(11.6): populate from quorum_state
        "questions": [],          # TODO(11.6): populate from quorum_state
        "fields": {},             # TODO(11.6): structured field map
        "_shim": "11.6-pending",
    }


def _state_write_envelope(db: Any, quorum_id: str, kind: str, body: dict[str, Any]) -> str:
    """Write a state-mutation envelope to ``quorum_state_snapshots``.

    Returns the new envelope's id (used as proposal_id / question_id).
    """
    envelope_id = str(uuid.uuid4())
    envelope = {
        "id": envelope_id,
        "kind": kind,
        "body": body,
        "created_at": _now_iso(),
        "__shim__": "11.6-pending",
    }
    try:
        db.table("quorum_state_snapshots").insert({
            "quorum_id": quorum_id,
            "snapshot": envelope,
        }).execute()
    except Exception as exc:  # pragma: no cover — defensive
        raise ToolError(f"failed to persist state envelope: {exc!s}") from exc
    return envelope_id


# ---------------------------------------------------------------------------
# Public factory
# ---------------------------------------------------------------------------

def build(db: Any) -> FastMCP:
    """Construct the ``mcp_state`` server bound to ``db``."""
    mcp = FastMCP("mcp_state")

    @mcp.tool()
    def get_quorum_state(quorum_id: str) -> dict[str, Any]:
        """Return the full blackboard state document for a quorum.

        See module docstring for the shape during 11.6 transition.
        """
        if not quorum_id:
            raise ToolError("quorum_id is required")
        return _state_get(db, quorum_id)

    @mcp.tool()
    def propose(
        quorum_id: str,
        field: str,
        content: str,
        proposed_by_role_id: str,
    ) -> dict[str, str]:
        """Submit a proposal to set/replace ``field`` on the blackboard.

        Returns ``{"proposal_id": <uuid>}``.
        """
        if not (quorum_id and field and proposed_by_role_id):
            raise ToolError("quorum_id, field, and proposed_by_role_id are required")
        pid = _state_write_envelope(
            db,
            quorum_id,
            kind="proposal",
            body={
                "field": field,
                "content": content,
                "proposed_by_role_id": proposed_by_role_id,
                "status": "open",
            },
        )
        return {"proposal_id": pid}

    @mcp.tool()
    def support_proposal(
        quorum_id: str,
        proposal_id: str,
        role_id: str,
    ) -> dict[str, bool]:
        """Cast a +1 on an open proposal.

        Returns ``{"ok": True}`` on success.
        """
        if not (quorum_id and proposal_id and role_id):
            raise ToolError("quorum_id, proposal_id, and role_id are required")
        _state_write_envelope(
            db,
            quorum_id,
            kind="proposal_support",
            body={"proposal_id": proposal_id, "role_id": role_id},
        )
        return {"ok": True}

    @mcp.tool()
    def block_proposal(
        quorum_id: str,
        proposal_id: str,
        role_id: str,
    ) -> dict[str, bool]:
        """Block an open proposal (authority-weighted veto).

        Returns ``{"ok": True}`` on success.
        """
        if not (quorum_id and proposal_id and role_id):
            raise ToolError("quorum_id, proposal_id, and role_id are required")
        _state_write_envelope(
            db,
            quorum_id,
            kind="proposal_block",
            body={"proposal_id": proposal_id, "role_id": role_id},
        )
        return {"ok": True}

    @mcp.tool()
    def raise_question(
        quorum_id: str,
        text: str,
        raised_by_role_id: str,
        tags: list[str] | None = None,
    ) -> dict[str, str]:
        """Post an open question to the blackboard.

        Returns ``{"question_id": <uuid>}``.
        """
        if not (quorum_id and text and raised_by_role_id):
            raise ToolError("quorum_id, text, and raised_by_role_id are required")
        qid = _state_write_envelope(
            db,
            quorum_id,
            kind="question",
            body={
                "text": text,
                "raised_by_role_id": raised_by_role_id,
                "tags": list(tags or []),
                "status": "open",
            },
        )
        return {"question_id": qid}

    return mcp
