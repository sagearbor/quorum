"""Tests for ``apps/api/quorum_state.py`` — checklist item 11.6.

These tests run against a deliberately small in-memory fake of the
Supabase / SQLite client interface that models exactly the four method
chains ``quorum_state`` uses:

  * ``db.table("quorum_state").select("*").eq("quorum_id", q).maybe_single().execute()``
  * ``db.table("quorum_state").insert(payload).execute()``
  * ``db.table("quorum_state").update(payload).eq("quorum_id", q).eq("version", v).execute()``
  * ``db.table("quorum_state").select("conflicts").eq(...).execute()``  (via get_state fallback)

Why a fake and not a real SQLite client?  The CAS race test needs to be
able to intercept a write mid-CAS to simulate a concurrent winner.  A
manual fake makes that trivial; a real SQLite would either need threading
+ explicit BEGIN IMMEDIATE or a monkeypatch on the update path.  We
already cover schema correctness with the migration file itself.

Coverage:
- init_state is idempotent
- propose adds an entry that get_state can read back
- support and block toggle each other and dedup
- decide moves a proposal into decisions linking back via source_proposal_id
- dissent stores reason + decision_id
- CAS race: first UPDATE loses (rowcount 0), retry wins
- detect_conflicts finds same-field different-content pairs
"""

from __future__ import annotations

import asyncio
import copy
from typing import Any

import pytest

# Module under test — import via bare name to match how routes/agent_engine
# import each other.  apps/api/tests/conftest.py puts apps/api on sys.path.
from quorum_state import (
    BlackboardConflictError,
    block,
    decide,
    detect_conflicts,
    dissent,
    get_state,
    init_state,
    propose,
    raise_question,
    support,
)


# ---------------------------------------------------------------------------
# In-memory fake DB modelling the quorum_state table
# ---------------------------------------------------------------------------


class _FakeQuorumStateDB:
    """Tiny fake of the Supabase / SQLite client scoped to ``quorum_state``.

    The on-disk state is a dict keyed by quorum_id → row dict.  Filters are
    accumulated on the query builder and resolved at .execute().  Update
    returns an APIResponse-like object with ``.data`` set to the list of
    matched rows (post-update) — which is the contract our CAS helper
    relies on.

    Optional ``on_update`` hook lets a test inject a "concurrent winner"
    mutation BEFORE the UPDATE is applied — this is how the CAS race test
    simulates losing a round.
    """

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}
        self.insert_calls: list[dict] = []
        self.update_calls: list[dict] = []
        # Hook fired once per UPDATE attempt.  Receives (self, filters,
        # payload) and may mutate self.rows[...] before the UPDATE runs.
        # Callers set this to a callable to simulate a racing winner.
        self.on_update_attempt = None

    def table(self, name: str) -> "_Query":
        assert name == "quorum_state", f"only quorum_state table supported, got {name}"
        return _Query(self)


class _Query:
    def __init__(self, db: _FakeQuorumStateDB) -> None:
        self.db = db
        self.filters: dict[str, Any] = {}
        self._select_cols: str | None = None
        self._pending_insert: dict | None = None
        self._pending_update: dict | None = None
        self._maybe_single = False

    # -- builder chain --------------------------------------------------

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

    # -- execute --------------------------------------------------------

    def execute(self) -> Any:
        if self._pending_insert is not None:
            row = dict(self._pending_insert)
            qid = row["quorum_id"]
            if qid in self.db.rows:
                # PRIMARY KEY violation — mirrors Postgres unique error.
                raise RuntimeError(
                    f"duplicate key: quorum_state.quorum_id={qid} already exists"
                )
            self.db.rows[qid] = row
            self.db.insert_calls.append(row)
            return _ApiResp(data=row)

        if self._pending_update is not None:
            qid = self.filters.get("quorum_id")
            expected_version = self.filters.get("version")
            # Fire the race hook if set — this is how tests simulate a
            # concurrent winner taking the row before our UPDATE runs.
            if self.db.on_update_attempt is not None:
                self.db.on_update_attempt(self.db, self.filters, self._pending_update)
            row = self.db.rows.get(qid)
            if row is None:
                return _ApiResp(data=[])
            if expected_version is not None and row.get("version") != expected_version:
                # CAS miss — return empty so caller sees "lost the race".
                return _ApiResp(data=[])
            row.update(self._pending_update)
            self.db.update_calls.append({"quorum_id": qid, **self._pending_update})
            return _ApiResp(data=[dict(row)])

        # SELECT path -------------------------------------------------
        qid = self.filters.get("quorum_id")
        row = self.db.rows.get(qid)
        if self._maybe_single:
            return _ApiResp(data=(dict(row) if row else None))
        return _ApiResp(data=([dict(row)] if row else []))


class _ApiResp:
    """Minimal stand-in for supabase.APIResponse / sqlite_client.APIResponse."""

    __slots__ = ("data",)

    def __init__(self, data: Any) -> None:
        self.data = data


# ---------------------------------------------------------------------------
# get_state / init_state
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_state_returns_defaults_when_no_row():
    """get_state must return the canonical empty snapshot without writing."""
    db = _FakeQuorumStateDB()
    state = await get_state(db, "q1")

    assert state["quorum_id"] == "q1"
    for field in ("open_questions", "proposals", "decisions", "conflicts", "dissents"):
        assert state[field] == [], f"{field} must default to empty list"
    assert state["version"] == 1
    # Critically, no row was inserted as a side effect of reading.
    assert db.rows == {}
    assert db.insert_calls == []


@pytest.mark.asyncio
async def test_init_state_is_idempotent():
    """Calling init_state twice must NOT overwrite or duplicate the row."""
    db = _FakeQuorumStateDB()

    first = await init_state(db, "q1")
    second = await init_state(db, "q1")

    assert first["quorum_id"] == "q1"
    assert second["quorum_id"] == "q1"
    # Exactly one row, exactly one insert call.
    assert list(db.rows.keys()) == ["q1"]
    assert len(db.insert_calls) == 1


# ---------------------------------------------------------------------------
# propose
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_propose_adds_entry_and_get_state_reads_it_back():
    db = _FakeQuorumStateDB()
    await init_state(db, "q1")

    pid = await propose(
        db,
        "q1",
        field="dosage",
        content="50mg twice daily",
        proposed_by_role_id="role-A",
    )
    assert pid, "propose must return a non-empty proposal_id"

    state = await get_state(db, "q1")
    assert len(state["proposals"]) == 1
    p = state["proposals"][0]
    assert p["id"] == pid
    assert p["field"] == "dosage"
    assert p["content"] == "50mg twice daily"
    assert p["proposed_by_role_id"] == "role-A"
    assert p["supporters"] == []
    assert p["blockers"] == []
    # Version bumped on the write.
    assert state["version"] == 2


@pytest.mark.asyncio
async def test_propose_without_init_auto_inits_row():
    """propose on a fresh quorum must transparently init the row."""
    db = _FakeQuorumStateDB()
    pid = await propose(
        db,
        "q-fresh",
        field="endpoint",
        content="HbA1c reduction",
        proposed_by_role_id="role-Z",
    )
    state = await get_state(db, "q-fresh")
    assert len(state["proposals"]) == 1
    assert state["proposals"][0]["id"] == pid


# ---------------------------------------------------------------------------
# support / block
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_support_and_block_flip_the_right_list():
    db = _FakeQuorumStateDB()
    pid = await propose(
        db, "q1", field="dose", content="X", proposed_by_role_id="role-A",
    )

    await support(db, "q1", pid, "role-B")
    state = await get_state(db, "q1")
    p = state["proposals"][0]
    assert p["supporters"] == ["role-B"]
    assert p["blockers"] == []

    # Supporting again is a no-op (dedup).
    await support(db, "q1", pid, "role-B")
    state = await get_state(db, "q1")
    assert state["proposals"][0]["supporters"] == ["role-B"]

    # Now block from the same role — should remove from supporters AND add
    # to blockers (the two lists must stay disjoint per role).
    await block(db, "q1", pid, "role-B")
    state = await get_state(db, "q1")
    p = state["proposals"][0]
    assert "role-B" not in p["supporters"]
    assert "role-B" in p["blockers"]


@pytest.mark.asyncio
async def test_support_missing_proposal_is_noop():
    """Calling support against an unknown proposal_id must not crash or
    create a phantom row.
    """
    db = _FakeQuorumStateDB()
    await init_state(db, "q1")

    # Should not raise.
    await support(db, "q1", "nonexistent-proposal-id", "role-A")
    state = await get_state(db, "q1")
    assert state["proposals"] == []


# ---------------------------------------------------------------------------
# decide
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_decide_moves_proposal_into_decisions():
    db = _FakeQuorumStateDB()
    pid = await propose(
        db,
        "q1",
        field="endpoint",
        content="HbA1c < 7%",
        proposed_by_role_id="role-A",
    )
    did = await decide(
        db,
        "q1",
        proposal_id=pid,
        decided_by_role_id="role-PI",
        authority_rank=8,
    )

    state = await get_state(db, "q1")
    assert len(state["decisions"]) == 1
    d = state["decisions"][0]
    assert d["id"] == did
    assert d["source_proposal_id"] == pid
    assert d["decided_by_role_id"] == "role-PI"
    assert d["authority_rank"] == 8
    # Field + content copied from the source proposal.
    assert d["field"] == "endpoint"
    assert d["content"] == "HbA1c < 7%"
    # Proposal is preserved (history is sacred).
    assert len(state["proposals"]) == 1


@pytest.mark.asyncio
async def test_decide_missing_proposal_is_noop():
    db = _FakeQuorumStateDB()
    await init_state(db, "q1")

    # No proposal exists — decide() should return an id but not append.
    did = await decide(
        db,
        "q1",
        proposal_id="ghost",
        decided_by_role_id="role-PI",
        authority_rank=8,
    )
    state = await get_state(db, "q1")
    assert state["decisions"] == [], "no decision should be appended for missing proposal"
    # The returned id is a fresh UUID even though nothing was written —
    # caller can ignore it.  This keeps the signature stable.
    assert did


# ---------------------------------------------------------------------------
# dissent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dissent_records_against_decision():
    db = _FakeQuorumStateDB()
    pid = await propose(
        db, "q1", field="dose", content="50mg", proposed_by_role_id="role-A",
    )
    did = await decide(
        db, "q1", proposal_id=pid, decided_by_role_id="role-PI", authority_rank=8,
    )

    diss_id = await dissent(
        db,
        "q1",
        decision_id=did,
        dissenting_role_id="role-Safety",
        reason="conflicts with renal exclusion criteria",
    )

    state = await get_state(db, "q1")
    assert len(state["dissents"]) == 1
    d = state["dissents"][0]
    assert d["id"] == diss_id
    assert d["decision_id"] == did
    assert d["dissenting_role_id"] == "role-Safety"
    assert d["reason"] == "conflicts with renal exclusion criteria"


# ---------------------------------------------------------------------------
# raise_question
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_raise_question_appends_to_open_questions():
    db = _FakeQuorumStateDB()
    qid = await raise_question(
        db,
        "q1",
        text="What is the primary endpoint?",
        raised_by_role_id="role-PI",
        tags=["endpoint", "design"],
    )

    state = await get_state(db, "q1")
    assert len(state["open_questions"]) == 1
    q = state["open_questions"][0]
    assert q["id"] == qid
    assert q["text"] == "What is the primary endpoint?"
    assert q["raised_by_role_id"] == "role-PI"
    assert q["tags"] == ["endpoint", "design"]


# ---------------------------------------------------------------------------
# CAS race
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cas_race_first_write_loses_then_retry_wins():
    """Simulate a concurrent winner taking the row before our UPDATE.

    On the FIRST UPDATE attempt, the race hook bumps the row's version so
    our CAS WHERE version=v misses and returns empty (lost the race).
    The mutate-with-CAS helper must re-read, see version=2, retry against
    that, and succeed on the SECOND attempt.
    """
    db = _FakeQuorumStateDB()
    await init_state(db, "q1")

    # Pre-seed a proposal so we have something to support.
    pid = await propose(
        db, "q1", field="x", content="X", proposed_by_role_id="role-A",
    )
    # After propose, version should be 2 (init=1 → propose=2).
    assert db.rows["q1"]["version"] == 2

    # Arm the race: first time we see an UPDATE, bump version BEFORE it
    # gets compared.  Use a closure counter so only the FIRST update is
    # raced.
    state = {"races_left": 1}

    def race_hook(database, filters, payload):
        if state["races_left"] > 0:
            state["races_left"] -= 1
            # Concurrent writer bumped the row's version mid-flight.
            row = database.rows[filters["quorum_id"]]
            row["version"] = row["version"] + 1

    db.on_update_attempt = race_hook

    # Now support: the first CAS UPDATE will miss (version stale), and the
    # helper must retry.  After the retry, supporters should be populated.
    await support(db, "q1", pid, "role-B")

    final = await get_state(db, "q1")
    p = final["proposals"][0]
    assert p["supporters"] == ["role-B"], (
        "after CAS retry, the support call should have landed exactly once"
    )
    # Race fired exactly once.
    assert state["races_left"] == 0


@pytest.mark.asyncio
async def test_cas_race_persistent_failure_raises_blackboard_conflict():
    """If EVERY retry loses the race, BlackboardConflictError is raised.

    This is the unhealthy-contention bail-out — callers should surface
    the error rather than spin forever.
    """
    db = _FakeQuorumStateDB()
    await init_state(db, "q1")
    pid = await propose(
        db, "q1", field="x", content="X", proposed_by_role_id="role-A",
    )

    # Race EVERY update attempt — the helper will exhaust its retry budget
    # (3 retries) and raise.
    def always_race(database, filters, payload):
        row = database.rows[filters["quorum_id"]]
        row["version"] = row["version"] + 1

    db.on_update_attempt = always_race

    with pytest.raises(BlackboardConflictError):
        await support(db, "q1", pid, "role-B")


# ---------------------------------------------------------------------------
# detect_conflicts
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_detect_conflicts_finds_same_field_different_content():
    """Two proposals on the same field with DIFFERENT content → 1 conflict."""
    db = _FakeQuorumStateDB()
    p1 = await propose(
        db, "q1", field="dose", content="50mg", proposed_by_role_id="role-A",
    )
    p2 = await propose(
        db, "q1", field="dose", content="100mg", proposed_by_role_id="role-B",
    )
    # Same-field but IDENTICAL content → must NOT count as a conflict.
    p3 = await propose(
        db, "q1", field="endpoint", content="HbA1c", proposed_by_role_id="role-A",
    )
    p4 = await propose(
        db, "q1", field="endpoint", content="HbA1c", proposed_by_role_id="role-B",
    )

    conflicts = await detect_conflicts(db, "q1")
    assert len(conflicts) == 1
    c = conflicts[0]
    assert c["field"] == "dose"
    # Conflict references both proposal ids, regardless of order.
    assert set(c["proposals"]) == {p1, p2}
    assert "raised_at" in c
    assert "id" in c

    # Run detect_conflicts again — must NOT duplicate the existing entry.
    conflicts2 = await detect_conflicts(db, "q1")
    assert len(conflicts2) == 1
    assert conflicts2[0]["id"] == c["id"]


@pytest.mark.asyncio
async def test_detect_conflicts_returns_empty_with_no_overlap():
    db = _FakeQuorumStateDB()
    await propose(
        db, "q1", field="dose", content="50mg", proposed_by_role_id="role-A",
    )
    await propose(
        db, "q1", field="endpoint", content="HbA1c", proposed_by_role_id="role-B",
    )
    conflicts = await detect_conflicts(db, "q1")
    assert conflicts == []
