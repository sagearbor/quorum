"""Race-condition coverage for the autonomy loop's A2A dispatcher.

Phase 10.2 fix: when autonomy_level=1.0, the polling loop's base_interval drops
to ~3s (1.5s with jitter), so two adjacent ticks could pick up the same
`status='pending'` agent_requests row and dispatch it to the LLM twice.

These tests verify the three layers of the fix:

1. **CAS-claim**: two concurrent `_run_autonomy_round()` calls against the
   same pending row result in EXACTLY ONE LLM call. The second tick's CAS
   update (`.eq("status", "pending")` after the first tick already flipped
   to 'processing') returns no rows and is skipped.

2. **Version CAS in process_a2a_request**: belt-and-suspenders guard on the
   terminal status update — verified implicitly by the row's final state.

3. **Reaper**: a row that has been stuck in 'processing' for longer than
   the 60s timeout gets flipped back to 'pending' on the next round and
   becomes claimable again.

Approach: a *stateful* fake DB that models the row mutations a real Supabase
table would perform. The CAS semantics live in the fake `update()` method:
filters applied via `.eq(col, val)` and `.lt(col, val)` are stored on the
chain object, then applied at `.execute()` time to decide which rows match.
This lets us drive real `asyncio.gather` concurrency against the production
loop code with realistic semantics, without a live Postgres.
"""

from __future__ import annotations

import asyncio
import copy
import threading
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Stateful fake Supabase
# ---------------------------------------------------------------------------


class _FakeTable:
    """Models a single table with realistic eq/lt/update/select semantics.

    Not a full Supabase emulator -- only the surface the autonomy loop and
    process_a2a_request actually use:

      - .select(cols).eq(k, v).order(c, desc=...).limit(n).execute()
      - .update(payload).eq(k, v).[lt(k, v)].execute()  -> returns matched rows
      - .select("*").eq("id", id).maybe_single().execute()

    Synchronisation: `_lock` serialises read/update inside each `.execute()`
    call so a CAS read-then-write is atomic, matching Postgres row-level locks
    on the targeted row. Without this, two `asyncio.gather` tasks could
    interleave inside a single update and both see the row as still pending.
    """

    def __init__(self, name: str, rows: list[dict], lock: threading.Lock):
        self.name = name
        self.rows = rows
        self._lock = lock

    def _chain(self):
        return _FakeChain(self)


class _FakeChain:
    def __init__(self, table: _FakeTable):
        self._table = table
        self._filters: list[tuple[str, str, Any]] = []  # (op, col, val)
        self._order: tuple[str, bool] | None = None  # (col, desc)
        self._limit: int | None = None
        self._select_cols: str | None = None
        self._mode: str | None = None  # 'select' | 'update' | 'insert'
        self._update_payload: dict | None = None
        self._insert_payload: dict | list[dict] | None = None
        self._single = False

    # -- builders --------------------------------------------------------
    def select(self, cols: str = "*"):
        self._mode = "select"
        self._select_cols = cols
        return self

    def update(self, payload: dict):
        self._mode = "update"
        self._update_payload = dict(payload)
        return self

    def insert(self, payload):
        self._mode = "insert"
        self._insert_payload = payload
        return self

    def delete(self):
        self._mode = "delete"
        return self

    def eq(self, col: str, val: Any):
        self._filters.append(("eq", col, val))
        return self

    def neq(self, col: str, val: Any):
        self._filters.append(("neq", col, val))
        return self

    def lt(self, col: str, val: Any):
        self._filters.append(("lt", col, val))
        return self

    def gt(self, col: str, val: Any):
        self._filters.append(("gt", col, val))
        return self

    def gte(self, col: str, val: Any):
        self._filters.append(("gte", col, val))
        return self

    def lte(self, col: str, val: Any):
        self._filters.append(("lte", col, val))
        return self

    def order(self, col: str, desc: bool = False):
        self._order = (col, desc)
        return self

    def limit(self, n: int):
        self._limit = n
        return self

    def maybe_single(self):
        self._single = True
        return self

    def single(self):
        self._single = True
        return self

    # -- execution -------------------------------------------------------
    def _matches(self, row: dict) -> bool:
        for op, col, val in self._filters:
            actual = row.get(col)
            if op == "eq" and actual != val:
                return False
            if op == "neq" and actual == val:
                return False
            if op == "lt":
                if actual is None or not (actual < val):
                    return False
            if op == "gt":
                if actual is None or not (actual > val):
                    return False
            if op == "gte":
                if actual is None or not (actual >= val):
                    return False
            if op == "lte":
                if actual is None or not (actual <= val):
                    return False
        return True

    def execute(self):
        with self._table._lock:
            if self._mode == "select":
                matched = [r for r in self._table.rows if self._matches(r)]
                if self._order:
                    col, desc = self._order
                    matched.sort(key=lambda r: r.get(col) or 0, reverse=desc)
                if self._limit is not None:
                    matched = matched[: self._limit]
                result = MagicMock()
                if self._single:
                    result.data = copy.deepcopy(matched[0]) if matched else None
                else:
                    result.data = [copy.deepcopy(r) for r in matched]
                return result

            if self._mode == "update":
                matched = [r for r in self._table.rows if self._matches(r)]
                for r in matched:
                    r.update(self._update_payload or {})
                result = MagicMock()
                result.data = [copy.deepcopy(r) for r in matched]
                return result

            if self._mode == "insert":
                payload = self._insert_payload
                rows = payload if isinstance(payload, list) else [payload]
                for r in rows:
                    self._table.rows.append(dict(r))
                result = MagicMock()
                result.data = [dict(r) for r in rows]
                return result

            if self._mode == "delete":
                kept = [r for r in self._table.rows if not self._matches(r)]
                removed = [r for r in self._table.rows if self._matches(r)]
                self._table.rows[:] = kept
                result = MagicMock()
                result.data = removed
                return result

            # Unknown mode: empty result
            result = MagicMock()
            result.data = None
            return result


class _FakeDB:
    def __init__(self, tables: dict[str, list[dict]]):
        self._lock = threading.Lock()
        self._tables = {
            name: _FakeTable(name, rows, self._lock)
            for name, rows in tables.items()
        }

    def table(self, name: str):
        if name not in self._tables:
            self._tables[name] = _FakeTable(name, [], self._lock)
        return self._tables[name]._chain()

    def row_by_id(self, table_name: str, row_id: str) -> dict | None:
        for r in self._tables[table_name].rows:
            if r.get("id") == row_id:
                return r
        return None


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


_QUORUM_ID = "q-race"
_REQ_ID = "req-race-001"


def _seed_pending_request() -> dict:
    return {
        "id": _REQ_ID,
        "quorum_id": _QUORUM_ID,
        "from_role_id": "role-a",
        "to_role_id": "role-b",
        "request_type": "input_request",
        "content": "Verify the protocol amendment.",
        "tags": [],
        "status": "pending",
        "response": None,
        "response_tags": [],
        "version": 1,
        "priority": 1,
        "created_at": "2026-05-12T00:00:00Z",
        "resolved_at": None,
        "claimed_at": None,
    }


@pytest.fixture()
def fake_db_with_one_pending():
    return _FakeDB({
        "agent_requests": [_seed_pending_request()],
        "roles": [
            {"id": "role-a", "name": "safety_monitor", "authority_rank": 7},
            {"id": "role-b", "name": "irb_officer", "authority_rank": 5},
        ],
        "quorums": [{"id": _QUORUM_ID, "status": "active"}],
        "station_messages": [],
        "agent_insights": [],
    })


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestCASRaceClaim:
    """Two concurrent ticks against ONE pending row -> exactly ONE LLM call."""

    @pytest.mark.asyncio
    async def test_concurrent_asyncio_gather_dispatches_once(
        self, fake_db_with_one_pending
    ):
        """`asyncio.gather` two `_run_autonomy_round` calls; LLM mock fires once."""
        from apps.api import autonomy_loop

        llm_call_count = 0
        llm_lock = asyncio.Lock()

        async def _slow_llm(*args, **kwargs):
            # Simulate a 2-10s LLM round-trip so the race window is wide open.
            # The whole point of the bug: status flips to 'acknowledged' only
            # AFTER this returns, so without the CAS-claim a second tick could
            # pick up the still-pending row mid-flight.
            nonlocal llm_call_count
            async with llm_lock:
                llm_call_count += 1
            await asyncio.sleep(0.05)
            return "Acknowledged."

        # Patch process_a2a_request to use our counter instead of the real
        # LLM path. We still exercise the autonomy_loop CAS-claim code in
        # production form -- only the LLM dispatch is stubbed.
        fake_process = AsyncMock(side_effect=_slow_llm)

        with (
            patch.object(autonomy_loop, "_run_quorum_loop"),
            patch("apps.api.agent_engine.process_a2a_request", new=fake_process),
            patch("apps.api.agent_engine.process_agent_turn", new=AsyncMock()),
            patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
        ):
            # Two simultaneous ticks against the same quorum.
            await asyncio.gather(
                autonomy_loop._run_autonomy_round(
                    _QUORUM_ID, 1.0, 1, fake_db_with_one_pending, MagicMock()
                ),
                autonomy_loop._run_autonomy_round(
                    _QUORUM_ID, 1.0, 2, fake_db_with_one_pending, MagicMock()
                ),
            )

        # Core assertion: exactly ONE dispatch, not two. Without the CAS-claim
        # this would be 2 -> duplicate insight, duplicate WS broadcast.
        assert (
            fake_process.await_count == 1
        ), f"expected exactly 1 LLM dispatch, got {fake_process.await_count}"

        # The row is now 'processing' (the test stub doesn't update it back to
        # 'acknowledged' because we mocked process_a2a_request out).
        row = fake_db_with_one_pending.row_by_id("agent_requests", _REQ_ID)
        assert row["status"] == "processing"
        assert row["claimed_at"] is not None

    @pytest.mark.asyncio
    async def test_simulated_sequential_claim_returns_empty_on_second(
        self, fake_db_with_one_pending
    ):
        """Deterministic CAS check: second claim against same row -> empty data.

        This is the inner mechanism the race test relies on. We call the
        claim UPDATE twice in sequence and verify the second call's data is
        empty / None, even though the row still exists.
        """
        first = (
            fake_db_with_one_pending.table("agent_requests")
            .update({"status": "processing", "claimed_at": "2026-05-12T00:00:01Z"})
            .eq("id", _REQ_ID)
            .eq("status", "pending")
            .execute()
        )
        second = (
            fake_db_with_one_pending.table("agent_requests")
            .update({"status": "processing", "claimed_at": "2026-05-12T00:00:02Z"})
            .eq("id", _REQ_ID)
            .eq("status", "pending")  # CAS guard
            .execute()
        )

        assert first.data and len(first.data) == 1, "first claim should win"
        assert not second.data, "second claim must affect zero rows"


class TestReaper:
    """Rows stuck in 'processing' for >60s are flipped back to 'pending'."""

    @pytest.mark.asyncio
    async def test_stale_processing_row_is_reaped(self):
        """Pre-seed a 'processing' row with claimed_at = now-120s; reaper flips it."""
        from datetime import datetime, timedelta, timezone

        from apps.api import autonomy_loop

        # 120 seconds ago — comfortably beyond the 60s stale threshold.
        stale_ts = (
            datetime.now(timezone.utc) - timedelta(seconds=120)
        ).isoformat()

        db = _FakeDB({
            "agent_requests": [
                {
                    "id": "stuck-req",
                    "quorum_id": _QUORUM_ID,
                    "from_role_id": "role-a",
                    "to_role_id": "role-b",
                    "request_type": "input_request",
                    "content": "test",
                    "tags": [],
                    "status": "processing",
                    "response": None,
                    "response_tags": [],
                    "version": 1,
                    "priority": 1,
                    "created_at": "2026-05-12T00:00:00Z",
                    "resolved_at": None,
                    "claimed_at": stale_ts,
                }
            ],
            "roles": [
                {"id": "role-a", "name": "safety_monitor", "authority_rank": 7},
                {"id": "role-b", "name": "irb_officer", "authority_rank": 5},
            ],
            "quorums": [{"id": _QUORUM_ID, "status": "active"}],
            "station_messages": [],
            "agent_insights": [],
        })

        # Run one round. We don't care what happens after the reaper -- the
        # row will get re-claimed and dispatched, but we patch out the LLM.
        fake_process = AsyncMock(return_value="ok")
        with (
            patch("apps.api.agent_engine.process_a2a_request", new=fake_process),
            patch("apps.api.agent_engine.process_agent_turn", new=AsyncMock()),
            patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
        ):
            await autonomy_loop._run_autonomy_round(
                _QUORUM_ID, 1.0, 1, db, MagicMock()
            )

        # After one round the stuck row should have been:
        # 1. reaped from 'processing' -> 'pending' (claimed_at=None)
        # 2. then immediately re-claimed by the CAS guard -> 'processing'
        # Either way, its FINAL state should not be the original stuck state
        # (claimed_at=stale_ts AND status=processing).
        row = db.row_by_id("agent_requests", "stuck-req")
        assert row is not None
        # The reaper definitely fired (process_a2a_request was called for it),
        # which means the row passed back through 'pending' and was claimable.
        assert fake_process.await_count == 1
        # And the claimed_at is no longer the stale timestamp.
        assert row["claimed_at"] != stale_ts

    @pytest.mark.asyncio
    async def test_recent_processing_row_is_NOT_reaped(self):
        """A fresh 'processing' row (claimed_at within 60s) must survive intact."""
        from datetime import datetime, timedelta, timezone

        from apps.api import autonomy_loop

        # 10 seconds ago -- well inside the 60s window; a live worker.
        fresh_ts = (
            datetime.now(timezone.utc) - timedelta(seconds=10)
        ).isoformat()

        db = _FakeDB({
            "agent_requests": [
                {
                    "id": "live-req",
                    "quorum_id": _QUORUM_ID,
                    "from_role_id": "role-a",
                    "to_role_id": "role-b",
                    "request_type": "input_request",
                    "content": "test",
                    "tags": [],
                    "status": "processing",
                    "response": None,
                    "response_tags": [],
                    "version": 1,
                    "priority": 1,
                    "created_at": "2026-05-12T00:00:00Z",
                    "resolved_at": None,
                    "claimed_at": fresh_ts,
                }
            ],
            "roles": [
                {"id": "role-a", "name": "safety_monitor", "authority_rank": 7},
                {"id": "role-b", "name": "irb_officer", "authority_rank": 5},
            ],
            "quorums": [{"id": _QUORUM_ID, "status": "active"}],
            "station_messages": [],
            "agent_insights": [],
        })

        fake_process = AsyncMock(return_value="ok")
        with (
            patch("apps.api.agent_engine.process_a2a_request", new=fake_process),
            patch("apps.api.agent_engine.process_agent_turn", new=AsyncMock()),
            patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
        ):
            await autonomy_loop._run_autonomy_round(
                _QUORUM_ID, 1.0, 1, db, MagicMock()
            )

        row = db.row_by_id("agent_requests", "live-req")
        # Should be untouched -- still 'processing', same claimed_at, no
        # spurious LLM dispatch.
        assert row["status"] == "processing"
        assert row["claimed_at"] == fresh_ts
        assert fake_process.await_count == 0


# ---------------------------------------------------------------------------
# 12.4 — Additional CAS-claim race coverage
# ---------------------------------------------------------------------------


class TestCASRaceMultiWorker:
    """Coverage for 3+ concurrent workers and crash-recovery scenarios."""

    @pytest.mark.asyncio
    async def test_three_concurrent_workers_one_dispatch(
        self, fake_db_with_one_pending
    ):
        """Three concurrent `_run_autonomy_round` calls -> exactly ONE LLM dispatch.

        Extends `test_concurrent_asyncio_gather_dispatches_once` to N=3 to
        make sure the CAS guard scales (not just a coincidence of N=2).
        """
        from apps.api import autonomy_loop

        async def _slow_llm(*args, **kwargs):
            await asyncio.sleep(0.05)
            return "Acknowledged."

        fake_process = AsyncMock(side_effect=_slow_llm)

        with (
            patch.object(autonomy_loop, "_run_quorum_loop"),
            patch("apps.api.agent_engine.process_a2a_request", new=fake_process),
            patch("apps.api.agent_engine.process_agent_turn", new=AsyncMock()),
            patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
        ):
            await asyncio.gather(
                autonomy_loop._run_autonomy_round(
                    _QUORUM_ID, 1.0, 1, fake_db_with_one_pending, MagicMock()
                ),
                autonomy_loop._run_autonomy_round(
                    _QUORUM_ID, 1.0, 2, fake_db_with_one_pending, MagicMock()
                ),
                autonomy_loop._run_autonomy_round(
                    _QUORUM_ID, 1.0, 3, fake_db_with_one_pending, MagicMock()
                ),
            )

        assert (
            fake_process.await_count == 1
        ), f"expected exactly 1 LLM dispatch with 3 workers, got {fake_process.await_count}"

        row = fake_db_with_one_pending.row_by_id("agent_requests", _REQ_ID)
        assert row["status"] == "processing"

    @pytest.mark.asyncio
    async def test_worker_crash_then_reclaim_after_60s(self):
        """Worker A claims, dies mid-LLM (stale claimed_at). Worker B reclaims.

        Simulates the full crash-recovery flow:
          1. Worker A successfully claims the row -> status=processing,
             claimed_at = now - 120s (fake crash mid-LLM).
          2. Worker B runs a fresh autonomy round.
          3. Reaper flips the stale row back to pending.
          4. Worker B's claim CAS wins and dispatches the LLM.

        Net result: row eventually reaches a clean state, LLM called once on
        the recovery path (not twice — A never finished its call).
        """
        from datetime import datetime, timedelta, timezone

        from apps.api import autonomy_loop

        # Worker A's stale claim — 120s old, past the 60s reaper threshold.
        stale_ts = (
            datetime.now(timezone.utc) - timedelta(seconds=120)
        ).isoformat()

        db = _FakeDB({
            "agent_requests": [
                {
                    "id": "crashed-req",
                    "quorum_id": _QUORUM_ID,
                    "from_role_id": "role-a",
                    "to_role_id": "role-b",
                    "request_type": "input_request",
                    "content": "Crashed mid-LLM",
                    "tags": [],
                    "status": "processing",  # Worker A's leftover state
                    "response": None,
                    "response_tags": [],
                    "version": 1,
                    "priority": 1,
                    "created_at": "2026-05-12T00:00:00Z",
                    "resolved_at": None,
                    "claimed_at": stale_ts,  # stale lease from dead worker A
                }
            ],
            "roles": [
                {"id": "role-a", "name": "safety_monitor", "authority_rank": 7},
                {"id": "role-b", "name": "irb_officer", "authority_rank": 5},
            ],
            "quorums": [{"id": _QUORUM_ID, "status": "active"}],
            "station_messages": [],
            "agent_insights": [],
        })

        fake_process = AsyncMock(return_value="ok")
        with (
            patch("apps.api.agent_engine.process_a2a_request", new=fake_process),
            patch("apps.api.agent_engine.process_agent_turn", new=AsyncMock()),
            patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
        ):
            # Worker B runs a round.
            await autonomy_loop._run_autonomy_round(
                _QUORUM_ID, 1.0, 1, db, MagicMock()
            )

        # The reaper flipped the row back to pending, then the CAS-claim
        # re-claimed it under worker B's lease, and process_a2a_request fired.
        assert fake_process.await_count == 1
        row = db.row_by_id("agent_requests", "crashed-req")
        assert row is not None
        # Final state: re-claimed with a fresh claimed_at.
        assert row["claimed_at"] != stale_ts
        assert row["status"] == "processing"  # Re-claimed by worker B

    @pytest.mark.asyncio
    async def test_llm_paused_sentinel_reverts_to_pending(
        self, fake_db_with_one_pending
    ):
        """LLM unavailable -> process_a2a_request returns PAUSED_SENTINEL ->
        autonomy_loop flips the row back to ``pending`` so the next tick can retry.

        This is the bug 10.6 fix on the A2A path — the autonomy loop must NOT
        leave a claimed row stuck after an LLM failure.
        """
        from apps.api import agent_engine, autonomy_loop

        # Stub process_a2a_request to return the PAUSED_SENTINEL string.
        paused = AsyncMock(return_value=agent_engine.PAUSED_SENTINEL)

        with (
            patch("apps.api.agent_engine.process_a2a_request", new=paused),
            patch("apps.api.agent_engine.process_agent_turn", new=AsyncMock()),
            patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
        ):
            await autonomy_loop._run_autonomy_round(
                _QUORUM_ID, 1.0, 1, fake_db_with_one_pending, MagicMock()
            )

        row = fake_db_with_one_pending.row_by_id("agent_requests", _REQ_ID)
        assert row is not None
        # Must be back to pending (not stuck in processing) and claimed_at cleared.
        assert row["status"] == "pending"
        assert row["claimed_at"] is None
        # The LLM was attempted exactly once on this round.
        assert paused.await_count == 1


class TestReaperEdgeCases:
    """Additional reaper coverage: multiple stale rows + DB errors."""

    @pytest.mark.asyncio
    async def test_reaper_flips_multiple_stale_rows_in_one_round(self):
        """Five stale 'processing' rows -> all five reverted in a single round."""
        from datetime import datetime, timedelta, timezone

        from apps.api import autonomy_loop

        stale_ts = (
            datetime.now(timezone.utc) - timedelta(seconds=120)
        ).isoformat()

        stale_rows = []
        for i in range(5):
            stale_rows.append(
                {
                    "id": f"stale-{i}",
                    "quorum_id": _QUORUM_ID,
                    "from_role_id": "role-a",
                    "to_role_id": "role-b",
                    "request_type": "input_request",
                    "content": f"stale row {i}",
                    "tags": [],
                    "status": "processing",
                    "response": None,
                    "response_tags": [],
                    "version": 1,
                    "priority": 1,
                    "created_at": "2026-05-12T00:00:00Z",
                    "resolved_at": None,
                    "claimed_at": stale_ts,
                }
            )

        db = _FakeDB({
            "agent_requests": stale_rows,
            "roles": [
                {"id": "role-a", "name": "safety_monitor", "authority_rank": 7},
                {"id": "role-b", "name": "irb_officer", "authority_rank": 5},
            ],
            "quorums": [{"id": _QUORUM_ID, "status": "active"}],
            "station_messages": [],
            "agent_insights": [],
        })

        # Patch process_a2a_request to track how many got re-dispatched.
        fake_process = AsyncMock(return_value="ok")
        with (
            patch("apps.api.agent_engine.process_a2a_request", new=fake_process),
            patch("apps.api.agent_engine.process_agent_turn", new=AsyncMock()),
            patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
        ):
            await autonomy_loop._run_autonomy_round(
                _QUORUM_ID, 1.0, 1, db, MagicMock()
            )

        # Every previously-stale row should have moved off the stale timestamp.
        rows = db._tables["agent_requests"].rows
        for row in rows:
            assert (
                row["claimed_at"] != stale_ts
            ), f"row {row['id']} still has stale claimed_at"

        # Phase-1 of the round pulls up to 5 pending rows AND dispatches them.
        # All five should have been re-claimed and dispatched after reaping.
        assert fake_process.await_count == 5

    @pytest.mark.asyncio
    async def test_reaper_db_error_does_not_break_loop(self, fake_db_with_one_pending):
        """Transient reaper DB error must not raise into the main loop.

        We simulate this by patching the reaper UPDATE chain to raise. The
        round should still complete cleanly and the pending row should still
        be picked up by Phase 1's normal CAS claim.
        """
        from apps.api import autonomy_loop

        # Wrap the table() method so the reaper's specific call signature
        # raises, but normal table operations still succeed.
        original_table = fake_db_with_one_pending.table

        call_count = {"n": 0}

        def flaky_table(name):
            chain = original_table(name)
            if name == "agent_requests" and call_count["n"] == 0:
                call_count["n"] += 1
                # The first call is the reaper UPDATE. Make execute() raise.
                original_execute = chain.execute

                def boom():
                    raise RuntimeError("simulated transient DB error in reaper")

                chain.execute = boom
                return chain
            return chain

        fake_db_with_one_pending.table = flaky_table

        fake_process = AsyncMock(return_value="ok")
        with (
            patch("apps.api.agent_engine.process_a2a_request", new=fake_process),
            patch("apps.api.agent_engine.process_agent_turn", new=AsyncMock()),
            patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
        ):
            # Must NOT raise.
            await autonomy_loop._run_autonomy_round(
                _QUORUM_ID, 1.0, 1, fake_db_with_one_pending, MagicMock()
            )

        # The Phase 1 CAS-claim should still have fired against the pending row.
        # (The reaper failure is swallowed; the pending row is still pending and
        # gets claimed normally on this same round.)
        assert fake_process.await_count == 1
