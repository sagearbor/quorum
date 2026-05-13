"""Blackboard helpers for the orchestrator — checklist item 11.6.

Backs the ``quorum_state`` table introduced by
``supabase/migrations/20260513000003_quorum_state.sql`` (mirrored in
``apps/api/db/sqlite_schema.sql`` for local mode).

Why this module exists
----------------------
The Magentic-One ``OrchestratorAgent`` (PR #14) currently plans speaker
selection from a snapshot of recent contributions — it has no shared
"what the quorum believes right now" surface to consult.  That makes
authority arbitration (11.7) impossible: there is no "current proposal"
object to override, and no "open decision" object to dissent against.

The blackboard is one row per quorum holding five jsonb lists:

  * ``open_questions``  — things the quorum is trying to answer
  * ``proposals``       — concrete suggestions for artifact fields
  * ``decisions``       — proposals that have been ratified
  * ``conflicts``       — sets of proposals on the same field with
                          different content (computed by detect_conflicts)
  * ``dissents``        — formal "I disagree" records against decisions

Concurrency model — CAS on ``version``
--------------------------------------
The Supabase Python client does not transparently support
``UPDATE ... RETURNING`` with the row-version pattern.  Instead every
mutation here follows the same five-step recipe:

    1.  SELECT the row (or initialise an in-memory default if absent)
    2.  Mutate the relevant jsonb list in pure Python
    3.  UPDATE ... WHERE quorum_id = ? AND version = ?  (returning rows)
    4.  If rowcount == 0 → someone else wrote first; sleep a short
        randomised jitter and retry from step 1 (up to 3 times)
    5.  On the third failure → raise ``BlackboardConflictError``

We deliberately keep the helper functions pure (``db`` is passed in as
the first arg, never imported globally) so tests can swap in a tiny
in-memory fake — see ``apps/api/tests/test_quorum_state.py``.

The ``init_state`` helper is idempotent: it INSERTs a default row only
when one is missing, and returns the existing row otherwise.  Callers
that just want to READ the state without forcing an INSERT should use
``get_state`` — it returns the default-shaped dict (all empty lists,
version=1) if no row exists, leaving the DB untouched.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import uuid
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants / exceptions
# ---------------------------------------------------------------------------

# Five top-level jsonb lists, all default empty.  Kept as a module-level
# constant so ``_default_state`` and ``init_state`` share one source of truth.
_LIST_FIELDS: tuple[str, ...] = (
    "open_questions",
    "proposals",
    "decisions",
    "conflicts",
    "dissents",
)

# Max CAS retries before we give up and raise.  Three is enough for the
# expected contention level (≤ a dozen concurrent agents per quorum) and
# bounded so a misbehaving caller can't spin forever.
_MAX_CAS_RETRIES: int = 3


class BlackboardConflictError(RuntimeError):
    """Raised when CAS retries exhaust without a winning write.

    Indicates persistent contention (or a stuck client holding the row).
    Callers MAY retry at the application layer with a longer backoff;
    most should surface the error so the orchestrator can fall back to
    its pre-blackboard speaker-election heuristics.
    """


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    """Generate a fresh UUID4 for an entry in one of the jsonb lists."""
    return str(uuid.uuid4())


def _default_state(quorum_id: str) -> dict[str, Any]:
    """Return the canonical empty-state dict for a quorum.

    Used by ``get_state`` when no row exists (returned as a read-only
    snapshot — NOT inserted) and by ``init_state`` (inserted on first call).
    """
    return {
        "quorum_id": quorum_id,
        "open_questions": [],
        "proposals": [],
        "decisions": [],
        "conflicts": [],
        "dissents": [],
        "version": 1,
        "updated_at": _now_iso(),
    }


def _coerce_list(raw: Any) -> list:
    """Tolerantly coerce a jsonb-column value into a Python list.

    Accepts:
      * None              — column missing or NULL → []
      * list              — already parsed (Supabase pg client) → return as-is
      * str (JSON-as-TEXT) — SQLite client → json.loads
    Anything else is treated as malformed → [] with a warning.
    """
    if raw is None:
        return []
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("quorum_state: malformed JSON in column; defaulting to []")
            return []
        return parsed if isinstance(parsed, list) else []
    logger.warning("quorum_state: unexpected column type %s; defaulting to []", type(raw))
    return []


def _normalise_row(row: dict[str, Any]) -> dict[str, Any]:
    """Turn a raw DB row into a canonical Python dict.

    Ensures every list field is a list (not a JSON string from SQLite) and
    fills in defaults for any missing column.  Idempotent — callers can
    apply it multiple times safely.
    """
    normalised: dict[str, Any] = {
        "quorum_id": row.get("quorum_id"),
        "version": row.get("version", 1),
        "updated_at": row.get("updated_at"),
    }
    for field in _LIST_FIELDS:
        normalised[field] = _coerce_list(row.get(field))
    return normalised


async def _read_row(db, quorum_id: str) -> dict[str, Any] | None:
    """Single-row read; returns None if no row exists.

    Wrapped here (instead of inline) so tests can swap in a fake DB without
    having to model ``.maybe_single().execute()`` semantics — the helper
    catches PostgREST's "0 rows" 406 too.
    """
    try:
        result = (
            db.table("quorum_state")
            .select("*")
            .eq("quorum_id", quorum_id)
            .maybe_single()
            .execute()
        )
    except Exception:  # noqa: BLE001 — defensive; treat any read error as "no row"
        logger.warning(
            "quorum_state._read_row: query failed for quorum=%s; treating as missing",
            quorum_id,
            exc_info=True,
        )
        return None
    if not result or not getattr(result, "data", None):
        return None
    return result.data


async def _cas_update(
    db,
    quorum_id: str,
    *,
    expected_version: int,
    fields: dict[str, Any],
) -> bool:
    """Attempt one CAS-update round.  Returns True iff exactly one row was hit.

    The Supabase Python client returns the updated rows in ``result.data``
    when the WHERE clause matches.  When the version filter fails, no rows
    match and ``result.data`` is an empty list — that's our "lost the race"
    signal.

    The SQLite client mirrors that contract via its UPDATE → SELECT-after
    helper, so this function works against either backend with no branch.
    """
    payload = {**fields, "version": expected_version + 1, "updated_at": _now_iso()}
    try:
        result = (
            db.table("quorum_state")
            .update(payload)
            .eq("quorum_id", quorum_id)
            .eq("version", expected_version)
            .execute()
        )
    except Exception:  # noqa: BLE001
        logger.warning(
            "quorum_state._cas_update: write failed for quorum=%s v=%s",
            quorum_id,
            expected_version,
            exc_info=True,
        )
        return False
    data = getattr(result, "data", None) or []
    return len(data) > 0


async def _mutate_with_cas(db, quorum_id: str, mutator) -> dict[str, Any]:
    """Run ``mutator(state) -> updates`` against the blackboard with CAS retries.

    ``mutator`` receives a deep-copied canonical state dict (so it can mutate
    freely without affecting the next retry) and returns the dict of fields
    to write back — keys must be a subset of ``_LIST_FIELDS``.  It MAY also
    stash a per-call result on the closure (``nonlocal``) so the caller can
    recover, e.g., a newly-generated proposal_id.

    Raises ``BlackboardConflictError`` if every retry loses the race.
    """
    last_err: Exception | None = None
    for attempt in range(_MAX_CAS_RETRIES):
        row = await _read_row(db, quorum_id)
        if row is None:
            # No row yet — insert a default row first, then continue.
            await init_state(db, quorum_id)
            row = await _read_row(db, quorum_id)
            if row is None:
                # init_state must have inserted, but if a concurrent caller
                # also raced, we'll see the row on the next loop iteration.
                continue

        state = _normalise_row(row)
        # Make a defensive deep copy of the lists so the mutator can mutate
        # in place without us silently retrying with already-mutated data.
        snapshot: dict[str, Any] = {
            **state,
            **{f: [dict(item) if isinstance(item, dict) else item for item in state[f]] for f in _LIST_FIELDS},
        }
        try:
            updates = mutator(snapshot)
        except Exception as exc:  # noqa: BLE001
            # Mutator bugs are caller errors — re-raise immediately, do not
            # consume the retry budget.
            raise

        if not isinstance(updates, dict):
            raise TypeError(
                f"quorum_state mutator must return dict[str, list]; got {type(updates).__name__}"
            )

        bad = set(updates) - set(_LIST_FIELDS)
        if bad:
            raise ValueError(
                f"quorum_state mutator returned unknown fields: {sorted(bad)}"
            )

        won = await _cas_update(
            db,
            quorum_id,
            expected_version=int(state["version"]),
            fields=updates,
        )
        if won:
            # Return the merged post-write state for caller convenience.
            merged = {**snapshot, **updates}
            merged["version"] = int(state["version"]) + 1
            merged["updated_at"] = _now_iso()
            return merged

        # Lost the race — back off briefly and retry with a fresh read.
        # Jitter prevents synchronised retry storms when several agents
        # contend on the same quorum.
        await asyncio.sleep(random.uniform(0.01, 0.05))
        last_err = BlackboardConflictError(
            f"CAS retry {attempt + 1}/{_MAX_CAS_RETRIES} lost the race for quorum={quorum_id}"
        )

    raise BlackboardConflictError(
        f"Blackboard CAS failed after {_MAX_CAS_RETRIES} retries for quorum={quorum_id}"
    ) from last_err


# ---------------------------------------------------------------------------
# Public API — reads
# ---------------------------------------------------------------------------


async def get_state(db, quorum_id: str) -> dict[str, Any]:
    """Return the current blackboard for a quorum.

    If no row exists, returns the canonical default snapshot (all empty
    lists, version=1) WITHOUT inserting — read-only callers (the projector,
    the GET route) should not cause writes.  Callers that need a row to
    exist (e.g. to take the first lock) should call ``init_state``.
    """
    row = await _read_row(db, quorum_id)
    if row is None:
        return _default_state(quorum_id)
    return _normalise_row(row)


async def init_state(db, quorum_id: str) -> dict[str, Any]:
    """Insert a default blackboard row for the quorum if none exists.

    Idempotent: returns the existing row if one is already there (no
    overwrite), or the freshly-inserted default row otherwise.  The
    PRIMARY KEY constraint on ``quorum_id`` plus a try/except wrapper makes
    this safe under concurrent first-time inits — the loser of the race
    sees a unique-violation, swallows it, and re-reads the winner's row.
    """
    existing = await _read_row(db, quorum_id)
    if existing is not None:
        return _normalise_row(existing)

    seed = _default_state(quorum_id)
    insert_payload = {
        "quorum_id": quorum_id,
        "open_questions": [],
        "proposals": [],
        "decisions": [],
        "conflicts": [],
        "dissents": [],
        "version": 1,
        "updated_at": seed["updated_at"],
    }
    try:
        db.table("quorum_state").insert(insert_payload).execute()
    except Exception:  # noqa: BLE001
        # Concurrent INSERT raced us — re-read and return the winning row.
        logger.info(
            "quorum_state.init_state: insert lost the race for quorum=%s; re-reading",
            quorum_id,
            exc_info=True,
        )
        winner = await _read_row(db, quorum_id)
        if winner is not None:
            return _normalise_row(winner)
        # Truly catastrophic — return the default in-memory shape so callers
        # don't crash, but log loudly.
        logger.error(
            "quorum_state.init_state: insert failed AND no row visible afterwards for quorum=%s",
            quorum_id,
        )
        return seed
    return seed


# ---------------------------------------------------------------------------
# Public API — mutations
# ---------------------------------------------------------------------------


async def raise_question(
    db,
    quorum_id: str,
    *,
    text: str,
    raised_by_role_id: str,
    tags: list[str] | None = None,
) -> str:
    """Append a new open question.  Returns the generated question_id."""
    qid = _new_id()

    def _apply(state: dict[str, Any]) -> dict[str, Any]:
        new_entry = {
            "id": qid,
            "text": text,
            "raised_by_role_id": raised_by_role_id,
            "raised_at": _now_iso(),
            "tags": list(tags or []),
        }
        return {"open_questions": state["open_questions"] + [new_entry]}

    await _mutate_with_cas(db, quorum_id, _apply)
    return qid


async def propose(
    db,
    quorum_id: str,
    *,
    field: str,
    content: str,
    proposed_by_role_id: str,
) -> str:
    """Append a new proposal.  Returns the generated proposal_id.

    A proposal is a "this should be the artifact value for ``field``"
    suggestion.  Supporters/blockers start empty and are populated via
    ``support`` / ``block``.
    """
    pid = _new_id()

    def _apply(state: dict[str, Any]) -> dict[str, Any]:
        new_entry = {
            "id": pid,
            "field": field,
            "content": content,
            "proposed_by_role_id": proposed_by_role_id,
            "proposed_at": _now_iso(),
            "supporters": [],
            "blockers": [],
        }
        return {"proposals": state["proposals"] + [new_entry]}

    await _mutate_with_cas(db, quorum_id, _apply)
    return pid


async def support(db, quorum_id: str, proposal_id: str, role_id: str) -> None:
    """Add ``role_id`` to the proposal's supporters (dedup, also removes from blockers).

    No-ops if the proposal doesn't exist — callers can call this without
    pre-checking.  We don't raise on a missing proposal because the
    orchestrator might fire support/block in response to a transient
    speech act and we'd rather drop the signal than crash a turn.
    """

    def _apply(state: dict[str, Any]) -> dict[str, Any]:
        proposals = state["proposals"]
        for prop in proposals:
            if prop.get("id") != proposal_id:
                continue
            supporters = list(prop.get("supporters") or [])
            blockers = list(prop.get("blockers") or [])
            if role_id not in supporters:
                supporters.append(role_id)
            if role_id in blockers:
                blockers = [r for r in blockers if r != role_id]
            prop["supporters"] = supporters
            prop["blockers"] = blockers
            break
        else:
            # Proposal not found — return empty update so we don't bump version.
            return {}
        return {"proposals": proposals}

    await _mutate_with_cas(db, quorum_id, _apply)


async def block(db, quorum_id: str, proposal_id: str, role_id: str) -> None:
    """Add ``role_id`` to the proposal's blockers (dedup, also removes from supporters).

    Same no-op-on-missing contract as ``support``.
    """

    def _apply(state: dict[str, Any]) -> dict[str, Any]:
        proposals = state["proposals"]
        for prop in proposals:
            if prop.get("id") != proposal_id:
                continue
            supporters = list(prop.get("supporters") or [])
            blockers = list(prop.get("blockers") or [])
            if role_id not in blockers:
                blockers.append(role_id)
            if role_id in supporters:
                supporters = [r for r in supporters if r != role_id]
            prop["supporters"] = supporters
            prop["blockers"] = blockers
            break
        else:
            return {}
        return {"proposals": proposals}

    await _mutate_with_cas(db, quorum_id, _apply)


async def decide(
    db,
    quorum_id: str,
    *,
    proposal_id: str,
    decided_by_role_id: str,
    authority_rank: int,
) -> str:
    """Ratify a proposal into a decision.  Returns the new decision_id.

    The proposal stays in ``proposals`` (history is sacred — the projector
    wants to show "X proposed by R1 was ratified by R2") and a new entry is
    appended to ``decisions`` linking back via ``source_proposal_id``.
    Authority arbitration (11.7) will check ``authority_rank`` to decide
    which competing decision wins on the same field.
    """
    did = _new_id()

    def _apply(state: dict[str, Any]) -> dict[str, Any]:
        source = next((p for p in state["proposals"] if p.get("id") == proposal_id), None)
        if source is None:
            # No proposal to decide → leave state untouched, return empty patch.
            return {}
        new_entry = {
            "id": did,
            "field": source.get("field"),
            "content": source.get("content"),
            "decided_by_role_id": decided_by_role_id,
            "decided_at": _now_iso(),
            "authority_rank": authority_rank,
            "source_proposal_id": proposal_id,
        }
        return {"decisions": state["decisions"] + [new_entry]}

    await _mutate_with_cas(db, quorum_id, _apply)
    return did


async def dissent(
    db,
    quorum_id: str,
    *,
    decision_id: str,
    dissenting_role_id: str,
    reason: str,
) -> str:
    """Record a formal dissent against a decision.  Returns the dissent_id.

    Multiple dissents per decision are allowed (one per dissenting role);
    dissents do NOT override the decision — they're a parallel signal the
    projector and authority arbitrator can surface.
    """
    did = _new_id()

    def _apply(state: dict[str, Any]) -> dict[str, Any]:
        new_entry = {
            "id": did,
            "decision_id": decision_id,
            "dissenting_role_id": dissenting_role_id,
            "reason": reason,
            "dissented_at": _now_iso(),
        }
        return {"dissents": state["dissents"] + [new_entry]}

    await _mutate_with_cas(db, quorum_id, _apply)
    return did


async def detect_conflicts(db, quorum_id: str) -> list[dict[str, Any]]:
    """Find proposals that target the same field with different content.

    Writes detected conflicts into ``state.conflicts`` (additive — existing
    conflict entries are preserved) and returns the FULL conflicts list
    after the write.  Conflicts already recorded for the same combo of
    proposal_ids are NOT duplicated — we compare on the sorted-tuple of
    proposal IDs so order doesn't matter.

    The "same field, different content" rule is the cheap deterministic
    pass that the orchestrator can run every round; the LLM-driven
    semantic-conflict detector (existing ``quorum_llm.detect_conflicts``)
    still runs on top for fuzzy matches.
    """
    # Collect new conflicts under CAS so we never race with someone else
    # appending a proposal mid-scan.
    captured: list[dict[str, Any]] = []

    def _apply(state: dict[str, Any]) -> dict[str, Any]:
        proposals = state["proposals"]
        existing_conflicts = state["conflicts"]

        # Index existing conflict entries by sorted-proposal-id-tuple so we
        # can dedup additions.
        existing_keys: set[tuple[str, ...]] = set()
        for c in existing_conflicts:
            pids = c.get("proposals") or []
            if isinstance(pids, list):
                existing_keys.add(tuple(sorted(pids)))

        # Group proposals by field.
        by_field: dict[str, list[dict[str, Any]]] = {}
        for p in proposals:
            field = p.get("field")
            if not field:
                continue
            by_field.setdefault(field, []).append(p)

        new_conflicts: list[dict[str, Any]] = []
        for field, group in by_field.items():
            if len(group) < 2:
                continue
            # A "conflict" exists between any pair with DIFFERENT content.
            # We collapse all conflicting proposal ids for the field into a
            # single conflict entry — that's the projection the audience
            # cares about ("here is the field-level disagreement").
            contents = {p.get("content") for p in group}
            if len(contents) <= 1:
                # All identical → not a conflict.
                continue
            pids = sorted(str(p.get("id")) for p in group if p.get("id"))
            key = tuple(pids)
            if key in existing_keys:
                continue
            new_conflicts.append(
                {
                    "id": _new_id(),
                    "field": field,
                    "proposals": list(pids),
                    "raised_at": _now_iso(),
                }
            )
            existing_keys.add(key)

        merged = existing_conflicts + new_conflicts
        # Stash the merged list on the closure so the caller can return it.
        captured.append(merged)
        if not new_conflicts:
            # Nothing to write — return empty patch (skips CAS update entirely
            # if every mutator did this, but the CAS loop still tries once).
            return {"conflicts": merged} if False else {}
        return {"conflicts": merged}

    await _mutate_with_cas(db, quorum_id, _apply)
    # ``captured`` is populated by the (successful) mutator call.
    if captured:
        return captured[-1]
    # Fallback: re-read.
    state = await get_state(db, quorum_id)
    return state.get("conflicts") or []
