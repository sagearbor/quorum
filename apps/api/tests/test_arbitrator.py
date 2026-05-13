"""Tests for ``apps/api/agents/arbitrator.py`` — checklist item 11.7.

The arbitrator is a deterministic (no-LLM) function that consults the
``quorum_state.conflicts[]`` list, looks up each proposer's role and that
role's ``authority_rank``, and either:

  - writes a Decision for the highest-rank proposal + Dissent(s) for the
    losers; or
  - leaves the conflict open and flags it as ``ties_unresolved`` when the
    top rank is tied.

We test against an in-memory fake DB that models BOTH the ``quorum_state``
table (for the blackboard) AND the ``roles`` table (for authority_rank
lookups).  The fake mirrors the same shape as ``test_quorum_state.py`` but
adds a second table — the simplest correct way to exercise the arbitrator
end-to-end without spinning up SQLite.

Coverage matrix:
- 3-role conflict (ranks 3, 4, 5)        → role-5 wins, 2 dissents
- 2-role conflict (ranks 3, 5)           → role-5 wins, 1 dissent
- Tied authority (4 vs 4)                → no decision, conflict stays open
- Empty conflicts                        → returns zeros, no-op
- CAS race on conflict-removal           → exactly one set of decisions
- Missing authority_rank (NULL)          → treated as rank 0 + warning
- Conflict with deleted/missing role     → treated as rank 0
- record_dissent helper default reason   → uses ``authority_rank_override``
"""

from __future__ import annotations

import importlib
import sys
from typing import Any

import pytest


# ---------------------------------------------------------------------------
# Module setup — make ``agents.arbitrator`` resolvable via the bare name.
#
# Same dance as test_orchestrator.py: pytest runs from the project root, where
# the legacy root-level ``agents/`` package shadows our ``apps/api/agents``.
# We install ``apps.api.agents`` into the bare ``agents`` slot for the
# duration of each test in this file so ``from agents.arbitrator import ...``
# (used both here and by autonomy_loop.py) resolves to the right module.
# ---------------------------------------------------------------------------


def _install_apps_api_agents_as_bare() -> tuple[Any, Any]:
    qualified_pkg = importlib.import_module("apps.api.agents")
    qualified_sub = importlib.import_module("apps.api.agents.arbitrator")
    prior_pkg = sys.modules.get("agents")
    prior_sub = sys.modules.get("agents.arbitrator")
    sys.modules["agents"] = qualified_pkg
    sys.modules["agents.arbitrator"] = qualified_sub
    return prior_pkg, prior_sub


def _restore_bare_agents(prior_pkg: Any, prior_sub: Any) -> None:
    if prior_pkg is None:
        sys.modules.pop("agents", None)
    else:
        sys.modules["agents"] = prior_pkg
    if prior_sub is None:
        sys.modules.pop("agents.arbitrator", None)
    else:
        sys.modules["agents.arbitrator"] = prior_sub


@pytest.fixture(autouse=True)
def _bare_agents_alias():
    prior = _install_apps_api_agents_as_bare()
    try:
        yield
    finally:
        _restore_bare_agents(*prior)


# Module-under-test imports — go via the qualified path so they resolve
# regardless of which "agents" package is in sys.modules at collection time.
# Tests rely on the bare alias to make ``from agents.arbitrator import ...``
# inside production code (autonomy_loop) work, but here we use the qualified
# names directly to avoid name-collision surprises.
import quorum_state as _qs  # noqa: E402
from apps.api.agents.arbitrator import (  # noqa: E402
    DEFAULT_DISSENT_REASON,
    arbitrate_conflicts,
    record_dissent,
)


# ---------------------------------------------------------------------------
# In-memory fake DB modelling BOTH quorum_state and roles tables
# ---------------------------------------------------------------------------


class _FakeDB:
    """Models the two tables the arbitrator reads/writes.

    Rows are keyed by primary key in nested dicts:
      - ``quorum_state[quorum_id]`` → blackboard row (one per quorum)
      - ``roles[role_id]``          → role row with quorum_id + authority_rank

    The query builder accumulates filters and dispatches to a per-table
    executor that knows how to apply them.  Update on ``quorum_state``
    respects the CAS-on-version contract (returns empty data on miss).

    The ``on_update_attempt`` hook is only fired for ``quorum_state``
    updates, matching the original fake's semantics (we only race on the
    blackboard, never on roles).
    """

    def __init__(self) -> None:
        self.quorum_state: dict[str, dict[str, Any]] = {}
        self.roles: dict[str, dict[str, Any]] = {}
        self.on_update_attempt = None  # CAS race hook for quorum_state
        # Audit trails — handy for asserting "exactly one write" in race tests.
        self.qs_update_calls: list[dict] = []

    def table(self, name: str) -> "_Query":
        return _Query(self, name)

    # -- helpers for test setup --
    def add_role(
        self,
        role_id: str,
        quorum_id: str,
        *,
        authority_rank: int | None = 0,
        capacity: str = "unlimited",
        name: str | None = None,
        status: str = "active",
    ) -> None:
        self.roles[role_id] = {
            "id": role_id,
            "quorum_id": quorum_id,
            "name": name or role_id,
            "authority_rank": authority_rank,
            "capacity": capacity,
            "status": status,
        }


class _Query:
    def __init__(self, db: _FakeDB, table: str) -> None:
        self.db = db
        self.table_name = table
        self.filters: dict[str, Any] = {}
        self._select_cols: str | None = None
        self._pending_insert: dict | None = None
        self._pending_update: dict | None = None
        self._maybe_single = False
        self._limit: int | None = None
        self._order_by: tuple[str, bool] | None = None

    # builder chain ---------------------------------------------------------
    def select(self, cols: str = "*") -> "_Query":
        self._select_cols = cols
        return self

    def eq(self, key: str, value: Any) -> "_Query":
        self.filters[key] = value
        return self

    def maybe_single(self) -> "_Query":
        self._maybe_single = True
        return self

    def insert(self, row: dict) -> "_Query":
        self._pending_insert = row
        return self

    def update(self, payload: dict) -> "_Query":
        self._pending_update = payload
        return self

    def limit(self, n: int) -> "_Query":
        self._limit = n
        return self

    def order(self, col: str, desc: bool = False) -> "_Query":
        self._order_by = (col, desc)
        return self

    # execute ---------------------------------------------------------------
    def execute(self) -> Any:
        if self.table_name == "quorum_state":
            return self._execute_quorum_state()
        if self.table_name == "roles":
            return self._execute_roles()
        raise AssertionError(f"unsupported table in fake DB: {self.table_name}")

    def _execute_quorum_state(self) -> Any:
        if self._pending_insert is not None:
            row = dict(self._pending_insert)
            qid = row["quorum_id"]
            if qid in self.db.quorum_state:
                raise RuntimeError(
                    f"duplicate key: quorum_state.quorum_id={qid} already exists"
                )
            self.db.quorum_state[qid] = row
            return _ApiResp(data=row)

        if self._pending_update is not None:
            qid = self.filters.get("quorum_id")
            expected_version = self.filters.get("version")
            if self.db.on_update_attempt is not None:
                self.db.on_update_attempt(self.db, self.filters, self._pending_update)
            row = self.db.quorum_state.get(qid)
            if row is None:
                return _ApiResp(data=[])
            if expected_version is not None and row.get("version") != expected_version:
                return _ApiResp(data=[])
            row.update(self._pending_update)
            self.db.qs_update_calls.append({"quorum_id": qid, **self._pending_update})
            return _ApiResp(data=[dict(row)])

        # SELECT path
        qid = self.filters.get("quorum_id")
        row = self.db.quorum_state.get(qid)
        if self._maybe_single:
            return _ApiResp(data=(dict(row) if row else None))
        return _ApiResp(data=([dict(row)] if row else []))

    def _execute_roles(self) -> Any:
        # The arbitrator only reads roles; we deliberately don't model
        # update/insert paths (would distract from the focus of the test).
        if self._pending_insert is not None or self._pending_update is not None:
            raise AssertionError("test fake doesn't model writes to roles")
        rows = [
            dict(r)
            for r in self.db.roles.values()
            if all(r.get(k) == v for k, v in self.filters.items())
        ]
        if self._maybe_single:
            return _ApiResp(data=(rows[0] if rows else None))
        return _ApiResp(data=rows)


class _ApiResp:
    __slots__ = ("data",)

    def __init__(self, data: Any) -> None:
        self.data = data


# ---------------------------------------------------------------------------
# Setup helper — builds a quorum with N roles + N conflicting proposals.
# ---------------------------------------------------------------------------


async def _seed_conflict(
    db: _FakeDB,
    quorum_id: str,
    *,
    field: str,
    role_specs: list[tuple[str, int, str]],
) -> tuple[list[str], str]:
    """Seed ``len(role_specs)`` roles, one proposal per role on the same
    ``field`` with each role's content, and run detect_conflicts.

    role_specs is a list of (role_id, authority_rank, content) tuples.

    Returns (proposal_ids_in_seed_order, conflict_id).
    """
    for role_id, rank, _content in role_specs:
        db.add_role(role_id, quorum_id, authority_rank=rank, name=role_id)

    pids: list[str] = []
    for role_id, _rank, content in role_specs:
        pid = await _qs.propose(
            db,
            quorum_id,
            field=field,
            content=content,
            proposed_by_role_id=role_id,
        )
        pids.append(pid)

    conflicts = await _qs.detect_conflicts(db, quorum_id)
    # The seeding above must produce exactly one conflict on ``field``.
    matching = [c for c in conflicts if c.get("field") == field]
    assert len(matching) == 1, (
        f"expected exactly one conflict on {field!r}, got: {conflicts}"
    )
    return pids, matching[0]["id"]


# ---------------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_3role_conflict_highest_rank_wins_two_dissents():
    """Ranks 3, 4, 5 on the same field → role-5 wins; two dissents recorded.

    Also asserts:
      - The conflict is removed from quorum_state.conflicts[].
      - The decision is attributed to role-5 at rank 5.
      - Both lower-rank role IDs appear as dissenting_role_id, each with
        the default ``authority_rank_override`` reason.
    """
    db = _FakeDB()
    pids, _conflict_id = await _seed_conflict(
        db,
        "q1",
        field="dose",
        role_specs=[
            ("role-3", 3, "50mg"),
            ("role-4", 4, "75mg"),
            ("role-5", 5, "100mg"),
        ],
    )
    p_role5 = pids[2]

    result = await arbitrate_conflicts(db, "q1")

    assert result == {
        "decisions_made": 1,
        "dissents_recorded": 2,
        "ties_unresolved": 0,
    }, result

    state = await _qs.get_state(db, "q1")

    # Decision: sourced from role-5's proposal, at rank 5.
    assert len(state["decisions"]) == 1
    d = state["decisions"][0]
    assert d["source_proposal_id"] == p_role5
    assert d["decided_by_role_id"] == "role-5"
    assert d["authority_rank"] == 5
    assert d["field"] == "dose"
    assert d["content"] == "100mg"

    # Dissents: one each from role-3 and role-4, both pointed at this decision.
    assert len(state["dissents"]) == 2
    dissenting_roles = {x["dissenting_role_id"] for x in state["dissents"]}
    assert dissenting_roles == {"role-3", "role-4"}
    for diss in state["dissents"]:
        assert diss["decision_id"] == d["id"]
        assert diss["reason"] == DEFAULT_DISSENT_REASON

    # Conflict removed from the blackboard.
    assert state["conflicts"] == []


@pytest.mark.asyncio
async def test_2role_conflict_one_dissent():
    """Ranks 3, 5 on the same field → role-5 wins, exactly one dissent."""
    db = _FakeDB()
    pids, _ = await _seed_conflict(
        db,
        "q1",
        field="dose",
        role_specs=[
            ("role-3", 3, "50mg"),
            ("role-5", 5, "100mg"),
        ],
    )

    result = await arbitrate_conflicts(db, "q1")
    assert result == {
        "decisions_made": 1,
        "dissents_recorded": 1,
        "ties_unresolved": 0,
    }

    state = await _qs.get_state(db, "q1")
    assert len(state["decisions"]) == 1
    assert state["decisions"][0]["decided_by_role_id"] == "role-5"
    assert len(state["dissents"]) == 1
    assert state["dissents"][0]["dissenting_role_id"] == "role-3"
    assert state["conflicts"] == []


# ---------------------------------------------------------------------------
# Tie handling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tied_authority_leaves_conflict_open():
    """Two roles share max rank (4 vs 4) → no decision, conflict stays open."""
    db = _FakeDB()
    _pids, conflict_id = await _seed_conflict(
        db,
        "q1",
        field="dose",
        role_specs=[
            ("role-4a", 4, "50mg"),
            ("role-4b", 4, "100mg"),
        ],
    )

    result = await arbitrate_conflicts(db, "q1")
    assert result == {
        "decisions_made": 0,
        "dissents_recorded": 0,
        "ties_unresolved": 1,
    }

    state = await _qs.get_state(db, "q1")
    # Conflict still on the board.
    assert len(state["conflicts"]) == 1
    assert state["conflicts"][0]["id"] == conflict_id
    # No decision or dissent was written.
    assert state["decisions"] == []
    assert state["dissents"] == []


@pytest.mark.asyncio
async def test_tie_at_top_with_third_lower_rank_still_unresolved():
    """Tie at the top must NOT be silently broken by the third-place role.

    Ranks 5, 5, 3 → top-rank tie at 5; the rank-3 role does not break the
    deadlock.  No decision, ties_unresolved=1, conflict stays open.
    """
    db = _FakeDB()
    await _seed_conflict(
        db,
        "q1",
        field="dose",
        role_specs=[
            ("role-5a", 5, "50mg"),
            ("role-5b", 5, "100mg"),
            ("role-3", 3, "25mg"),
        ],
    )

    result = await arbitrate_conflicts(db, "q1")
    assert result["decisions_made"] == 0
    assert result["dissents_recorded"] == 0
    assert result["ties_unresolved"] == 1

    state = await _qs.get_state(db, "q1")
    assert len(state["conflicts"]) == 1
    assert state["decisions"] == []


# ---------------------------------------------------------------------------
# No-op / edge cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_empty_conflicts_returns_zeros_and_is_noop():
    """No conflicts on the blackboard → return zeros, do not touch state."""
    db = _FakeDB()
    # Init the blackboard but with NO proposals → no conflicts.
    await _qs.init_state(db, "q1")
    db.qs_update_calls.clear()  # ignore the init write

    result = await arbitrate_conflicts(db, "q1")
    assert result == {
        "decisions_made": 0,
        "dissents_recorded": 0,
        "ties_unresolved": 0,
    }
    # Critically: no writes to quorum_state.
    assert db.qs_update_calls == []


@pytest.mark.asyncio
async def test_null_authority_rank_treated_as_zero():
    """A role with NULL authority_rank is rank 0 → other ranked role wins.

    This is the documented stop-condition from the 11.7 spec: don't crash
    on legacy rows, just log + fallback.
    """
    db = _FakeDB()
    # role-null has authority_rank=None → should be treated as rank 0.
    pids, _ = await _seed_conflict(
        db,
        "q1",
        field="dose",
        role_specs=[
            ("role-null", None, "50mg"),  # type: ignore[arg-type]
            ("role-2", 2, "100mg"),
        ],
    )

    result = await arbitrate_conflicts(db, "q1")
    # role-2 (rank 2) wins over role-null (rank 0).
    assert result["decisions_made"] == 1
    assert result["dissents_recorded"] == 1
    assert result["ties_unresolved"] == 0

    state = await _qs.get_state(db, "q1")
    assert state["decisions"][0]["decided_by_role_id"] == "role-2"
    assert state["dissents"][0]["dissenting_role_id"] == "role-null"


@pytest.mark.asyncio
async def test_proposer_role_missing_from_roles_table():
    """A proposal whose proposer role no longer exists → treated as rank 0.

    Simulates a quorum where a role was deleted after proposing; the
    arbitrator should still let the surviving ranked role win, not crash.
    """
    db = _FakeDB()
    db.add_role("role-3", "q1", authority_rank=3)
    # Note: NO role added for "role-ghost".
    p1 = await _qs.propose(
        db, "q1", field="dose", content="X", proposed_by_role_id="role-ghost"
    )
    p2 = await _qs.propose(
        db, "q1", field="dose", content="Y", proposed_by_role_id="role-3"
    )
    await _qs.detect_conflicts(db, "q1")

    result = await arbitrate_conflicts(db, "q1")
    assert result["decisions_made"] == 1
    assert result["ties_unresolved"] == 0

    state = await _qs.get_state(db, "q1")
    # role-3 wins over the ghost.
    assert state["decisions"][0]["decided_by_role_id"] == "role-3"
    assert state["decisions"][0]["source_proposal_id"] == p2
    # The ghost role still appears as the dissenter — we record the
    # ID we have, even if the role row is gone.
    assert state["dissents"][0]["dissenting_role_id"] == "role-ghost"
    # Suppress unused-warning.
    assert p1


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cas_race_two_concurrent_arbitrators_exactly_one_result():
    """Sequentially run two arbitrators; the second must be a no-op.

    The first call writes the decision + dissents + removes the conflict.
    The second call reads the now-empty conflicts list and returns zeros
    without writing anything more.  This is the practical "exactly one set
    of decisions written" guarantee — concurrent CAS in production is
    handled by ``_mutate_with_cas`` retrying; the contract we test here is
    that idempotent re-invocation is safe.
    """
    db = _FakeDB()
    await _seed_conflict(
        db,
        "q1",
        field="dose",
        role_specs=[
            ("role-3", 3, "50mg"),
            ("role-5", 5, "100mg"),
        ],
    )

    first = await arbitrate_conflicts(db, "q1")
    second = await arbitrate_conflicts(db, "q1")

    assert first["decisions_made"] == 1
    assert first["dissents_recorded"] == 1
    # Second sweep finds an empty conflicts list and writes nothing.
    assert second == {
        "decisions_made": 0,
        "dissents_recorded": 0,
        "ties_unresolved": 0,
    }
    # Exactly one decision on the board.
    state = await _qs.get_state(db, "q1")
    assert len(state["decisions"]) == 1
    assert len(state["dissents"]) == 1


# ---------------------------------------------------------------------------
# record_dissent helper
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_record_dissent_default_reason_is_authority_rank_override():
    """The helper must default ``reason`` to ``authority_rank_override``."""
    db = _FakeDB()
    # Seed enough state to have a decision to dissent against.
    pid = await _qs.propose(
        db, "q1", field="x", content="X", proposed_by_role_id="role-A"
    )
    did = await _qs.decide(
        db, "q1", proposal_id=pid, decided_by_role_id="role-PI", authority_rank=5
    )

    dissent_id = await record_dissent(
        db,
        quorum_id="q1",
        decision_id=did,
        dissenting_role_id="role-B",
    )
    assert dissent_id

    state = await _qs.get_state(db, "q1")
    assert len(state["dissents"]) == 1
    assert state["dissents"][0]["reason"] == DEFAULT_DISSENT_REASON
    assert state["dissents"][0]["dissenting_role_id"] == "role-B"


@pytest.mark.asyncio
async def test_record_dissent_custom_reason_overrides_default():
    """Explicit reason flows through unchanged."""
    db = _FakeDB()
    pid = await _qs.propose(
        db, "q1", field="x", content="X", proposed_by_role_id="role-A"
    )
    did = await _qs.decide(
        db, "q1", proposal_id=pid, decided_by_role_id="role-PI", authority_rank=5
    )

    await record_dissent(
        db,
        quorum_id="q1",
        decision_id=did,
        dissenting_role_id="role-B",
        reason="renal exclusion violation",
    )
    state = await _qs.get_state(db, "q1")
    assert state["dissents"][0]["reason"] == "renal exclusion violation"
