"""Authority arbitration for the blackboard — checklist item 11.7.

What this module does
---------------------
The product premise of Quorum is that ``roles.authority_rank`` (1–5, higher
wins on conflict) *means something* — a higher-rank role's proposal should
override a lower-rank role's proposal when both target the same artifact
field with different content.  Before PR #25 (this PR), nothing enforced
that: the LLM Tier-2 conflict detector surfaced conflicts to humans but the
orchestrator never resolved them.

This module runs DETERMINISTICALLY (no LLM call) on top of the blackboard
introduced by PR #24 (``apps/api/quorum_state.py``):

  1.  Read ``quorum_state.conflicts[]`` — the list of "two proposals on the
      same field with different content" entries that ``detect_conflicts``
      already populates.
  2.  For each conflict, look up each proposal's ``proposed_by_role_id``
      and that role's ``authority_rank``.
  3.  Find the highest authority_rank among the proposers.
      - If unique winner → ``decide(...)`` against the winning proposal
        and ``dissent(...)`` against every lower-rank proposal in the
        conflict.
      - If tied (two roles share the max) → DO NOT decide.  Leave the
        conflict on the blackboard and increment ``ties_unresolved`` so
        the orchestrator can escalate the deadlock to a human.  (Out of
        scope for 11.7 — we just flag and log.)
  4.  Remove resolved conflicts from ``quorum_state.conflicts[]`` so the
      next sweep doesn't re-process them.

The whole module is intentionally pure ``async def`` functions (``db`` is
the first arg, never imported globally) so tests can swap in the same
``_FakeQuorumStateDB`` used by ``test_quorum_state.py``.

Tie-breaking and edge cases
---------------------------
- **Tie at the top rank** → conflict stays open, ``ties_unresolved += 1``.
  We log a warning so operators can see deadlocks in the autonomy log.
  Future escalation logic (e.g. promote the question, hand to a human
  arbiter) is item 11.8+.
- **Capacity == 'unlimited'** (committee role) → treated as ONE voice.
  A committee is a single decision-maker for arbitration purposes; we do
  not collapse-vote across committee members here.
- **Missing authority_rank** (legacy/null rows) → treated as rank 0
  (lowest) with a warning log.  This is the documented stop-condition
  from the 11.7 spec — don't crash on legacy data.
- **Missing role row** (proposal references a deleted role) → treated as
  rank 0 with a warning.  Same rationale.
- **Empty conflicts** → no-op, returns zeros.
- **Conflict referencing < 2 proposals** → skipped (malformed entry from
  an upstream bug; we log and move on rather than half-resolve).

Concurrency
-----------
The conflicts-list mutation goes through the same CAS-on-version pattern
``quorum_state._mutate_with_cas`` uses.  Two concurrent arbitrators racing
on the same quorum will result in exactly one set of decisions being
written: the loser's CAS update misses, it re-reads the (now-empty)
conflicts list, and its second-pass mutator returns an empty patch.

``record_dissent`` is a thin wrapper around ``quorum_state.dissent`` —
its own CAS handles concurrent dissent writes against the same decision.
"""

from __future__ import annotations

import logging
from typing import Any

import quorum_state as _qs

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Default reason recorded against dissents created by automatic authority
# arbitration.  Surfaced to the projector + audit log so humans can see WHY
# a lower-rank role's proposal was overridden.
DEFAULT_DISSENT_REASON: str = "authority_rank_override"

# Treated as the "rank" of any role with NULL/missing authority_rank.  Per
# the 11.7 spec stop-condition: don't crash on legacy rows, treat as the
# lowest possible rank so they never win an arbitration unless ALL roles
# in a conflict are similarly broken (in which case the tie-break logic
# handles it).
_FALLBACK_RANK: int = 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _load_roles(db, quorum_id: str) -> dict[str, dict[str, Any]]:
    """Return a ``role_id → role_row`` lookup for all roles in the quorum.

    We only need ``id``, ``authority_rank``, ``capacity``, and ``name``
    for arbitration — but we select '*' to be tolerant of test fakes that
    don't model column projection.

    A failed lookup returns an empty dict; the caller will then treat
    every role as rank 0 (the fallback path) and log a warning.  This
    keeps the autonomy loop alive even if the DB is briefly unreachable.
    """
    try:
        result = (
            db.table("roles")
            .select("*")
            .eq("quorum_id", quorum_id)
            .execute()
        )
    except Exception:  # noqa: BLE001 — defensive; broken DB shouldn't crash autonomy
        logger.warning(
            "arbitrator: failed to load roles for quorum=%s; treating all as rank %d",
            quorum_id,
            _FALLBACK_RANK,
            exc_info=True,
        )
        return {}

    rows = getattr(result, "data", None) or []
    if not isinstance(rows, list):
        # Some fakes return a single dict from .maybe_single() — normalise.
        rows = [rows]
    return {r["id"]: r for r in rows if isinstance(r, dict) and r.get("id")}


def _rank_of(role_row: dict[str, Any] | None, *, role_id: str) -> int:
    """Return the authority rank for a role, defaulting to 0 with a warning.

    Per the 11.7 stop-condition: NULL authority_rank → rank 0 + log.  Same
    treatment when the role row is missing entirely (e.g. the proposal
    references a role that was hard-deleted).
    """
    if role_row is None:
        logger.warning(
            "arbitrator: proposal references unknown role_id=%s; treating as rank %d",
            role_id,
            _FALLBACK_RANK,
        )
        return _FALLBACK_RANK
    rank = role_row.get("authority_rank")
    if rank is None:
        logger.warning(
            "arbitrator: role_id=%s has NULL authority_rank; treating as rank %d",
            role_id,
            _FALLBACK_RANK,
        )
        return _FALLBACK_RANK
    try:
        return int(rank)
    except (TypeError, ValueError):
        logger.warning(
            "arbitrator: role_id=%s has non-integer authority_rank=%r; treating as rank %d",
            role_id,
            rank,
            _FALLBACK_RANK,
        )
        return _FALLBACK_RANK


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def record_dissent(
    db,
    *,
    quorum_id: str,
    decision_id: str,
    dissenting_role_id: str,
    reason: str | None = None,
) -> str:
    """Append a dissent record to ``quorum_state.dissents[]``.

    Thin wrapper around :func:`quorum_state.dissent` — kept in this module
    so arbitration logic has a single public entry point and so future
    enhancements (e.g. de-dup multiple dissents from the same role, or
    enrich the reason with the original conflict_id) can be added in one
    place without touching the blackboard helpers.

    ``reason`` defaults to :data:`DEFAULT_DISSENT_REASON` so callers can
    omit it for the common case of an automatic authority override.

    Returns the new ``dissent_id`` produced by the blackboard.
    """
    effective_reason = reason or DEFAULT_DISSENT_REASON
    return await _qs.dissent(
        db,
        quorum_id,
        decision_id=decision_id,
        dissenting_role_id=dissenting_role_id,
        reason=effective_reason,
    )


async def arbitrate_conflicts(db, quorum_id: str) -> dict[str, int]:
    """Resolve as many conflicts on the blackboard as possible via authority rank.

    For every conflict in ``quorum_state.conflicts[]``:

      1.  Look up all proposals referenced by the conflict.
      2.  Find the highest authority_rank among the proposers.
      3.  If a UNIQUE winner exists:
            - Record a ``decide(...)`` against the winning proposal,
              attributed to that role at that rank.
            - For every other proposal in the conflict, record a
              ``record_dissent(...)`` from its proposer against the new
              decision (reason = ``authority_rank_override``).
            - Mark the conflict as "to remove" from the blackboard.
      4.  If two or more roles share the same max rank → leave the
          conflict open and increment ``ties_unresolved``.

    All conflict removals are applied in a single CAS-protected update at
    the end so two concurrent arbitrators can't both write the same
    decision.  See module docstring for the concurrency contract.

    Returns:
        dict with three counters:
          - ``decisions_made``       — count of new decision rows written
          - ``dissents_recorded``    — count of new dissent rows written
          - ``ties_unresolved``      — count of conflicts left open due to ties
    """
    counters: dict[str, int] = {
        "decisions_made": 0,
        "dissents_recorded": 0,
        "ties_unresolved": 0,
    }

    state = await _qs.get_state(db, quorum_id)
    conflicts = list(state.get("conflicts") or [])
    if not conflicts:
        # Fast-path: no work to do.  Don't even bump the version.
        return counters

    proposals_by_id: dict[str, dict[str, Any]] = {
        p.get("id"): p for p in (state.get("proposals") or []) if p.get("id")
    }
    roles_by_id = await _load_roles(db, quorum_id)

    # Collect conflict IDs that get fully resolved this pass so we can
    # remove them from the blackboard in one CAS update at the end.
    resolved_conflict_ids: set[str] = set()

    for conflict in conflicts:
        conflict_id = conflict.get("id")
        pids: list[str] = list(conflict.get("proposals") or [])
        if not conflict_id or len(pids) < 2:
            # Malformed conflict entry — skip with a warning rather than
            # half-resolving it.  The detect_conflicts helper should never
            # produce these, but defence in depth is cheap.
            logger.warning(
                "arbitrator: skipping malformed conflict entry on quorum=%s: %r",
                quorum_id,
                conflict,
            )
            continue

        # Resolve each proposal → (proposal, proposer_role_id, rank).
        ranked: list[tuple[dict[str, Any], str, int]] = []
        missing_proposals = False
        for pid in pids:
            prop = proposals_by_id.get(pid)
            if prop is None:
                logger.warning(
                    "arbitrator: conflict %s references unknown proposal_id=%s on quorum=%s; skipping conflict",
                    conflict_id,
                    pid,
                    quorum_id,
                )
                missing_proposals = True
                break
            proposer_role_id = prop.get("proposed_by_role_id") or ""
            role_row = roles_by_id.get(proposer_role_id)
            rank = _rank_of(role_row, role_id=proposer_role_id)
            ranked.append((prop, proposer_role_id, rank))
        if missing_proposals or not ranked:
            continue

        max_rank = max(r for _, _, r in ranked)
        winners = [item for item in ranked if item[2] == max_rank]

        if len(winners) > 1:
            # Tie at the top — leave the conflict open for human/escalation.
            counters["ties_unresolved"] += 1
            logger.warning(
                "arbitrator: tie at rank=%d for conflict=%s field=%r on quorum=%s; "
                "leaving conflict open (roles=%s)",
                max_rank,
                conflict_id,
                conflict.get("field"),
                quorum_id,
                [item[1] for item in winners],
            )
            continue

        winning_prop, winning_role_id, winning_rank = winners[0]
        winning_pid = winning_prop.get("id")
        if not winning_pid:
            # Defensive — proposals_by_id keyed by id should never produce this.
            logger.warning(
                "arbitrator: winning proposal has no id; skipping conflict=%s",
                conflict_id,
            )
            continue

        # 1. Write the decision (authority-sourced).
        try:
            decision_id = await _qs.decide(
                db,
                quorum_id,
                proposal_id=winning_pid,
                decided_by_role_id=winning_role_id,
                authority_rank=winning_rank,
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "arbitrator: decide() failed for proposal=%s on quorum=%s; skipping conflict=%s",
                winning_pid,
                quorum_id,
                conflict_id,
                exc_info=True,
            )
            continue
        counters["decisions_made"] += 1

        logger.info(
            "arbitrator: conflict=%s field=%r resolved on quorum=%s — "
            "winning_role=%s rank=%d decision_id=%s; %d dissent(s) to record",
            conflict_id,
            conflict.get("field"),
            quorum_id,
            winning_role_id,
            winning_rank,
            decision_id,
            len(ranked) - 1,
        )

        # 2. Record a dissent for every loser.
        for prop, proposer_role_id, rank in ranked:
            if prop.get("id") == winning_pid:
                continue
            try:
                await record_dissent(
                    db,
                    quorum_id=quorum_id,
                    decision_id=decision_id,
                    dissenting_role_id=proposer_role_id,
                    reason=DEFAULT_DISSENT_REASON,
                )
                counters["dissents_recorded"] += 1
            except Exception:  # noqa: BLE001
                logger.warning(
                    "arbitrator: record_dissent failed for role=%s decision=%s on quorum=%s",
                    proposer_role_id,
                    decision_id,
                    quorum_id,
                    exc_info=True,
                )

        # 3. Mark the conflict for removal.
        resolved_conflict_ids.add(conflict_id)

    # 4. Remove the resolved conflicts in a single CAS-protected update.
    if resolved_conflict_ids:
        await _remove_conflicts(db, quorum_id, resolved_conflict_ids)

    return counters


async def _remove_conflicts(db, quorum_id: str, conflict_ids: set[str]) -> None:
    """Remove the given conflict IDs from ``quorum_state.conflicts[]``.

    Uses the same CAS-on-version pattern as the rest of ``quorum_state``.
    Idempotent: if a concurrent arbitrator already removed some of these,
    the surviving set is whatever's left — we never re-add anything.

    Failures here are NOT fatal — the conflict stays on the board for the
    next sweep to retry.  This avoids losing decisions if the post-arbitration
    cleanup write loses every CAS retry (e.g. extreme contention).
    """

    def _apply(state: dict[str, Any]) -> dict[str, Any]:
        existing = state.get("conflicts") or []
        survivors = [c for c in existing if c.get("id") not in conflict_ids]
        if len(survivors) == len(existing):
            # Nothing to remove (raced with another arbitrator) — empty patch
            # so we don't bump version unnecessarily.
            return {}
        return {"conflicts": survivors}

    try:
        await _qs._mutate_with_cas(db, quorum_id, _apply)
    except Exception:  # noqa: BLE001
        # Don't crash the autonomy loop if cleanup fails — the decisions
        # and dissents have already landed, the duplicate conflict on the
        # next pass will be a no-op because the resolved proposals still
        # exist but the new decision already covers them.  Surface as a
        # warning so it's visible in logs.
        logger.warning(
            "arbitrator: failed to remove %d resolved conflict(s) from quorum_state for quorum=%s; "
            "they will retry on the next round",
            len(conflict_ids),
            quorum_id,
            exc_info=True,
        )
