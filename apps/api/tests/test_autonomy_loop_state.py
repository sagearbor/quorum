"""Coverage for the autonomy_loop_state DB-backed lease (checklist item 11.5).

Before 11.5, ``autonomy_loop.py`` tracked active loops in a module-level
``_active_loops`` dict. That dict survived neither uvicorn restarts nor
multi-worker deployments. The fix promotes the registry to a Supabase table
with per-worker leases.

These tests cover:

1. start_autonomy_loop UPSERTs a row with status='running' + this worker_id.
2. _heartbeat_loop_state bumps heartbeat_at and round_num.
3. stop_autonomy_loop marks status='stopped' and clears worker_id.
4. reclaim_orphaned_autonomy_loops picks up rows stale > 60s
   (and only when AUTONOMY_LOOP_RECLAIM_ORPHANS=true does it resume them).
5. Simulated multi-worker: two workers' upserts result in the second's
   worker_id winning, and the first's heartbeat is a no-op.
6. The in-process _active_loops dict is a handle map, not the source of truth.

A stateful in-memory fake DB models the agent_endpoints/autonomy_loop_state
surface area we need — enough to exercise the production loop without
spinning up Postgres.
"""

from __future__ import annotations

import asyncio
import copy
import threading
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Minimal in-memory fake DB — same shape as test_autonomy_race's fake
# ---------------------------------------------------------------------------


class _FakeChain:
    def __init__(self, table: "_FakeTable"):
        self._table = table
        self._filters: list[tuple[str, str, Any]] = []
        self._mode: str | None = None
        self._update_payload: dict | None = None
        self._upsert_payload: dict | None = None
        self._on_conflict: str | None = None
        self._single = False
        self._select_cols: str | None = None

    def select(self, cols: str = "*"):
        self._mode = "select"
        self._select_cols = cols
        return self

    def update(self, payload: dict):
        self._mode = "update"
        self._update_payload = dict(payload)
        return self

    def upsert(self, payload: dict, *, on_conflict: str = "id"):
        self._mode = "upsert"
        self._upsert_payload = dict(payload)
        self._on_conflict = on_conflict
        return self

    def insert(self, payload: dict):
        self._mode = "insert"
        self._upsert_payload = dict(payload)
        return self

    def eq(self, col: str, val: Any):
        self._filters.append(("eq", col, val))
        return self

    def lt(self, col: str, val: Any):
        self._filters.append(("lt", col, val))
        return self

    def maybe_single(self):
        self._single = True
        return self

    def single(self):
        self._single = True
        return self

    def order(self, col: str, desc: bool = False):
        return self

    def limit(self, n: int):
        return self

    def _matches(self, row: dict) -> bool:
        for op, col, val in self._filters:
            actual = row.get(col)
            if op == "eq" and actual != val:
                return False
            if op == "lt":
                if actual is None or not (actual < val):
                    return False
        return True

    def execute(self):
        with self._table._lock:
            if self._mode == "select":
                matched = [r for r in self._table.rows if self._matches(r)]
                result = MagicMock()
                if self._single:
                    result.data = copy.deepcopy(matched[0]) if matched else None
                else:
                    result.data = [copy.deepcopy(r) for r in matched]
                return result

            if self._mode == "update":
                updated: list[dict] = []
                for row in self._table.rows:
                    if self._matches(row):
                        row.update(self._update_payload or {})
                        updated.append(row)
                result = MagicMock()
                result.data = [copy.deepcopy(r) for r in updated]
                return result

            if self._mode == "upsert":
                payload = self._upsert_payload or {}
                conflict = self._on_conflict or "id"
                key_val = payload.get(conflict)
                existing = next(
                    (r for r in self._table.rows if r.get(conflict) == key_val),
                    None,
                )
                if existing:
                    existing.update(payload)
                    result = MagicMock()
                    result.data = [copy.deepcopy(existing)]
                else:
                    self._table.rows.append(dict(payload))
                    result = MagicMock()
                    result.data = [copy.deepcopy(payload)]
                return result

            if self._mode == "insert":
                self._table.rows.append(dict(self._upsert_payload or {}))
                result = MagicMock()
                result.data = [copy.deepcopy(self._upsert_payload)]
                return result

            raise ValueError(f"unsupported mode {self._mode}")


class _FakeTable:
    def __init__(self, name: str, rows: list[dict], lock: threading.Lock):
        self.name = name
        self.rows = rows
        self._lock = lock

    def __call__(self, *args, **kwargs):
        return _FakeChain(self)


class _FakeDB:
    def __init__(self):
        self._lock = threading.Lock()
        self._tables: dict[str, list[dict]] = {
            "autonomy_loop_state": [],
            "quorums": [],
            "roles": [],
            "agent_requests": [],
            "station_messages": [],
            "agent_insights": [],
            "contributions": [],
        }

    def seed(self, table: str, rows: list[dict]):
        self._tables.setdefault(table, []).extend(rows)

    def table(self, name: str) -> _FakeChain:
        return _FakeChain(
            _FakeTable(name, self._tables.setdefault(name, []), self._lock)
        )

    def rows(self, name: str) -> list[dict]:
        return self._tables.setdefault(name, [])


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def db():
    return _FakeDB()


@pytest.fixture(autouse=True)
def _patch_get_supabase(db):
    """Route get_supabase() to our fake DB for every test."""
    with patch("database.get_supabase", return_value=db), \
         patch("apps.api.database.get_supabase", return_value=db):
        yield


@pytest.fixture(autouse=True)
def _clear_active_loops():
    """Clear the in-process handle map between tests so leakage doesn't matter."""
    from autonomy_loop import _active_loops

    _active_loops.clear()
    yield
    _active_loops.clear()


# ---------------------------------------------------------------------------
# 1. start_autonomy_loop UPSERTs a row with status='running' + worker_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_autonomy_loop_inserts_running_row(db):
    """A fresh start writes an autonomy_loop_state row with the current worker_id."""
    from autonomy_loop import _worker_id, start_autonomy_loop, stop_autonomy_loop

    quorum_id = "q-test-1"
    # We don't want the actual loop body to run — patch out the inner coroutine.
    with patch("autonomy_loop._run_quorum_loop", new=AsyncMock(return_value=None)):
        await start_autonomy_loop(quorum_id, 0.5)
        # Let the scheduled task run (it returns immediately since we mocked it).
        await asyncio.sleep(0)
        await stop_autonomy_loop(quorum_id)

    rows = db.rows("autonomy_loop_state")
    assert len(rows) == 1
    row = rows[0]
    assert row["quorum_id"] == quorum_id
    # status got flipped to 'stopped' by stop_autonomy_loop — that's correct.
    assert row["status"] == "stopped"
    # worker_id was set on start, cleared on stop.
    assert row["worker_id"] is None
    # autonomy_level was persisted.
    assert float(row["autonomy_level"]) == pytest.approx(0.5)


@pytest.mark.asyncio
async def test_start_autonomy_loop_sets_worker_id_on_active_row(db):
    """While the loop is alive (between start and stop), the row carries our worker_id."""
    from autonomy_loop import _worker_id, start_autonomy_loop, stop_autonomy_loop

    quorum_id = "q-test-2"
    with patch("autonomy_loop._run_quorum_loop", new=AsyncMock(return_value=None)):
        await start_autonomy_loop(quorum_id, 0.5)
        rows = db.rows("autonomy_loop_state")
        # Snapshot the row state RIGHT AFTER start — before any in-process
        # task transitions it.
        live = next((r for r in rows if r["quorum_id"] == quorum_id), None)
        assert live is not None
        assert live["status"] == "running"
        assert live["worker_id"] == _worker_id()
        await stop_autonomy_loop(quorum_id)


@pytest.mark.asyncio
async def test_zero_autonomy_does_not_create_row(db):
    """autonomy_level=0 is a no-op — no DB row, no in-process task."""
    from autonomy_loop import _active_loops, start_autonomy_loop

    await start_autonomy_loop("q-zero", 0.0)
    assert db.rows("autonomy_loop_state") == []
    assert "q-zero" not in _active_loops


# ---------------------------------------------------------------------------
# 2. _heartbeat_loop_state bumps heartbeat_at + round_num
# ---------------------------------------------------------------------------


def test_heartbeat_updates_only_matching_worker(db):
    """Heartbeat is a CAS on worker_id — it must NOT clobber a row owned elsewhere."""
    from autonomy_loop import _heartbeat_loop_state, _now_iso, _worker_id

    quorum_id = "q-heartbeat-1"
    db.seed(
        "autonomy_loop_state",
        [
            {
                "quorum_id": quorum_id,
                "autonomy_level": 0.5,
                "status": "running",
                "worker_id": "other-host:99999",  # NOT us
                "heartbeat_at": "2026-01-01T00:00:00+00:00",
                "round_num": 0,
            }
        ],
    )

    _heartbeat_loop_state(db, quorum_id, round_num=7)

    row = db.rows("autonomy_loop_state")[0]
    # Row still belongs to the other worker — heartbeat must not bump it.
    assert row["worker_id"] == "other-host:99999"
    assert row["heartbeat_at"] == "2026-01-01T00:00:00+00:00"
    assert row["round_num"] == 0


def test_heartbeat_updates_own_row(db):
    from autonomy_loop import _heartbeat_loop_state, _worker_id

    quorum_id = "q-heartbeat-2"
    db.seed(
        "autonomy_loop_state",
        [
            {
                "quorum_id": quorum_id,
                "autonomy_level": 0.5,
                "status": "running",
                "worker_id": _worker_id(),
                "heartbeat_at": "2026-01-01T00:00:00+00:00",
                "round_num": 0,
            }
        ],
    )

    _heartbeat_loop_state(db, quorum_id, round_num=42)

    row = db.rows("autonomy_loop_state")[0]
    assert row["round_num"] == 42
    # heartbeat_at advanced past the seeded sentinel.
    assert row["heartbeat_at"] != "2026-01-01T00:00:00+00:00"


# ---------------------------------------------------------------------------
# 3. stop_autonomy_loop marks status='stopped' and clears worker_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stop_clears_worker_id_and_marks_stopped(db):
    from autonomy_loop import _worker_id, start_autonomy_loop, stop_autonomy_loop

    quorum_id = "q-stop-1"
    with patch("autonomy_loop._run_quorum_loop", new=AsyncMock(return_value=None)):
        await start_autonomy_loop(quorum_id, 0.5)
        await stop_autonomy_loop(quorum_id)

    row = db.rows("autonomy_loop_state")[0]
    assert row["status"] == "stopped"
    assert row["worker_id"] is None


# ---------------------------------------------------------------------------
# 4. Reclaim picks up loops stale > 60s
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reclaim_marks_stale_running_rows_orphaned(db, monkeypatch):
    """When AUTONOMY_LOOP_RECLAIM_ORPHANS=false (default), stale rows just get
    flipped to 'orphaned' so future workers know nobody owns them.
    """
    from autonomy_loop import reclaim_orphaned_autonomy_loops

    monkeypatch.setenv("AUTONOMY_LOOP_RECLAIM_ORPHANS", "false")

    stale_ts = (datetime.now(timezone.utc) - timedelta(seconds=300)).isoformat()
    fresh_ts = datetime.now(timezone.utc).isoformat()

    db.seed(
        "autonomy_loop_state",
        [
            # stale: should be flipped to 'orphaned'
            {
                "quorum_id": "q-stale",
                "autonomy_level": 0.5,
                "status": "running",
                "worker_id": "dead-host:1",
                "heartbeat_at": stale_ts,
            },
            # fresh: must not be touched
            {
                "quorum_id": "q-fresh",
                "autonomy_level": 0.3,
                "status": "running",
                "worker_id": "live-host:2",
                "heartbeat_at": fresh_ts,
            },
            # already stopped: must not be touched
            {
                "quorum_id": "q-stopped",
                "autonomy_level": 0.4,
                "status": "stopped",
                "worker_id": None,
                "heartbeat_at": stale_ts,
            },
        ],
    )

    reclaimed = await reclaim_orphaned_autonomy_loops(db)

    assert "q-stale" in reclaimed
    assert "q-fresh" not in reclaimed
    assert "q-stopped" not in reclaimed

    by_id = {r["quorum_id"]: r for r in db.rows("autonomy_loop_state")}
    assert by_id["q-stale"]["status"] == "orphaned"
    assert by_id["q-fresh"]["status"] == "running"
    assert by_id["q-stopped"]["status"] == "stopped"


@pytest.mark.asyncio
async def test_reclaim_resumes_when_env_flag_set(db, monkeypatch):
    """With AUTONOMY_LOOP_RECLAIM_ORPHANS=true, reclaim also restarts the loop
    on the current worker — verified by checking start_autonomy_loop was called.
    """
    from autonomy_loop import reclaim_orphaned_autonomy_loops

    monkeypatch.setenv("AUTONOMY_LOOP_RECLAIM_ORPHANS", "true")

    stale_ts = (datetime.now(timezone.utc) - timedelta(seconds=300)).isoformat()
    db.seed(
        "autonomy_loop_state",
        [
            {
                "quorum_id": "q-resume",
                "autonomy_level": 0.6,
                "status": "running",
                "worker_id": "dead:1",
                "heartbeat_at": stale_ts,
            }
        ],
    )

    with patch(
        "autonomy_loop.start_autonomy_loop", new=AsyncMock(return_value=None)
    ) as start_mock:
        reclaimed = await reclaim_orphaned_autonomy_loops(db)

    assert reclaimed == ["q-resume"]
    start_mock.assert_awaited_once()
    args, kwargs = start_mock.await_args
    assert args[0] == "q-resume"
    assert args[1] == pytest.approx(0.6)
    assert kwargs.get("_is_reclaim") is True


@pytest.mark.asyncio
async def test_reclaim_handles_empty_table(db, monkeypatch):
    """No rows => no reclaim. Don't raise."""
    from autonomy_loop import reclaim_orphaned_autonomy_loops

    monkeypatch.setenv("AUTONOMY_LOOP_RECLAIM_ORPHANS", "true")
    out = await reclaim_orphaned_autonomy_loops(db)
    assert out == []


# ---------------------------------------------------------------------------
# 5. Two workers don't double-run: worker_id changes correctly
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_second_worker_upsert_overwrites_worker_id(db):
    """If worker A's loop dies and worker B calls start_autonomy_loop, the
    row's worker_id flips to B's. Worker A's surviving heartbeat would then
    be a no-op (covered by test_heartbeat_updates_only_matching_worker).
    """
    from autonomy_loop import _upsert_loop_state

    quorum_id = "q-multiworker"

    # Worker A
    _upsert_loop_state(
        db,
        quorum_id=quorum_id,
        autonomy_level=0.5,
        status="running",
        worker_id="worker-a:1",
    )

    # Worker B takes over
    _upsert_loop_state(
        db,
        quorum_id=quorum_id,
        autonomy_level=0.5,
        status="running",
        worker_id="worker-b:2",
    )

    rows = db.rows("autonomy_loop_state")
    assert len(rows) == 1  # PK collision => single row
    assert rows[0]["worker_id"] == "worker-b:2"


def test_lease_still_held_returns_false_when_worker_changes(db):
    from autonomy_loop import _lease_still_held, _worker_id

    quorum_id = "q-lease-1"
    # Row owned by SOMEONE ELSE.
    db.seed(
        "autonomy_loop_state",
        [
            {
                "quorum_id": quorum_id,
                "status": "running",
                "worker_id": "other:99",
                "autonomy_level": 0.5,
                "heartbeat_at": datetime.now(timezone.utc).isoformat(),
            }
        ],
    )
    assert _lease_still_held(db, quorum_id) is False


def test_lease_still_held_returns_true_when_we_own(db):
    from autonomy_loop import _lease_still_held, _worker_id

    quorum_id = "q-lease-2"
    db.seed(
        "autonomy_loop_state",
        [
            {
                "quorum_id": quorum_id,
                "status": "running",
                "worker_id": _worker_id(),
                "autonomy_level": 0.5,
                "heartbeat_at": datetime.now(timezone.utc).isoformat(),
            }
        ],
    )
    assert _lease_still_held(db, quorum_id) is True


def test_lease_still_held_returns_false_when_status_not_running(db):
    from autonomy_loop import _lease_still_held, _worker_id

    quorum_id = "q-lease-3"
    db.seed(
        "autonomy_loop_state",
        [
            {
                "quorum_id": quorum_id,
                "status": "stopped",
                "worker_id": _worker_id(),
                "autonomy_level": 0.5,
                "heartbeat_at": datetime.now(timezone.utc).isoformat(),
            }
        ],
    )
    assert _lease_still_held(db, quorum_id) is False


def test_lease_still_held_returns_false_when_row_missing(db):
    """No row => lease gone => loop should exit."""
    from autonomy_loop import _lease_still_held

    assert _lease_still_held(db, "q-no-row") is False


# ---------------------------------------------------------------------------
# 6. _active_loops dict is a handle map, not source of truth
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_active_loops_dict_tracks_in_process_task(db):
    """The dict exists ONLY so stop_autonomy_loop can cancel the local task.
    It is NOT consulted to answer "is this loop running?" — the DB is.
    """
    from autonomy_loop import _active_loops, start_autonomy_loop, stop_autonomy_loop

    quorum_id = "q-handle-map"
    with patch("autonomy_loop._run_quorum_loop", new=AsyncMock(return_value=None)):
        await start_autonomy_loop(quorum_id, 0.5)
        assert quorum_id in _active_loops
        await stop_autonomy_loop(quorum_id)
        assert quorum_id not in _active_loops


# ---------------------------------------------------------------------------
# Worker ID
# ---------------------------------------------------------------------------


def test_worker_id_format(monkeypatch):
    """${HOSTNAME}:${PID} — falls back to socket.gethostname()."""
    from autonomy_loop import _worker_id

    monkeypatch.setenv("HOSTNAME", "test-host")
    wid = _worker_id()
    assert wid.startswith("test-host:")
    pid_part = wid.split(":", 1)[1]
    assert pid_part.isdigit()
    assert int(pid_part) > 0


def test_worker_id_fallback_to_gethostname(monkeypatch):
    """Unset HOSTNAME → fall back to socket.gethostname()."""
    import socket

    from autonomy_loop import _worker_id

    monkeypatch.delenv("HOSTNAME", raising=False)
    wid = _worker_id()
    # Either gethostname() succeeded OR we fell back to "unknown".
    assert ":" in wid
    host_part = wid.split(":", 1)[0]
    assert host_part  # not empty


# ---------------------------------------------------------------------------
# 12.4 — Heartbeat lease integration coverage
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_loop_start_then_iteration_then_cancel_full_cycle(db):
    """Full lifecycle: start -> one heartbeat-ed iteration -> cancel.

    Verifies the row goes through:
        (no row) -> running+worker_id -> heartbeat_at advances -> stopped+null
    """
    from autonomy_loop import _heartbeat_loop_state, _worker_id, start_autonomy_loop, stop_autonomy_loop

    quorum_id = "q-full-cycle"

    # Patch _run_quorum_loop so it doesn't actually iterate forever.
    with patch("autonomy_loop._run_quorum_loop", new=AsyncMock(return_value=None)):
        await start_autonomy_loop(quorum_id, 0.5)

        # Row exists with status=running, our worker_id, round_num=0.
        rows = db.rows("autonomy_loop_state")
        assert len(rows) == 1
        row = rows[0]
        assert row["status"] == "running"
        assert row["worker_id"] == _worker_id()
        assert row["round_num"] == 0
        initial_heartbeat = row["heartbeat_at"]

        # Simulate one loop iteration's heartbeat. Real code calls
        # `_heartbeat_loop_state(db, quorum_id, round_num)` from inside the
        # while True body.
        await asyncio.sleep(0.001)  # ensure isoformat advances
        _heartbeat_loop_state(db, quorum_id, round_num=1)

        rows = db.rows("autonomy_loop_state")
        assert rows[0]["round_num"] == 1
        assert rows[0]["heartbeat_at"] != initial_heartbeat

        # Cancel.
        await stop_autonomy_loop(quorum_id)

    rows = db.rows("autonomy_loop_state")
    assert rows[0]["status"] == "stopped"
    assert rows[0]["worker_id"] is None


@pytest.mark.asyncio
async def test_two_workers_do_not_double_run(db):
    """Worker A starts the loop, then Worker B starts the same quorum.

    Both upserts target the same PK (quorum_id), so worker_id flips from A
    to B and only ONE row exists. Worker A's heartbeat is then a no-op
    because its CAS guard (worker_id=A) finds the row owned by B.
    """
    from autonomy_loop import _heartbeat_loop_state, _upsert_loop_state, _worker_id

    quorum_id = "q-two-workers"

    # Worker A claims.
    _upsert_loop_state(
        db,
        quorum_id=quorum_id,
        autonomy_level=0.5,
        status="running",
        worker_id="worker-a:1",
    )

    # Worker B takes over.
    _upsert_loop_state(
        db,
        quorum_id=quorum_id,
        autonomy_level=0.5,
        status="running",
        worker_id="worker-b:2",
    )

    rows = db.rows("autonomy_loop_state")
    assert len(rows) == 1
    assert rows[0]["worker_id"] == "worker-b:2"

    # Worker A's heartbeat must be a no-op — its CAS finds the wrong worker_id.
    # We patch _worker_id() to return "worker-a:1" for one call.
    with patch("autonomy_loop._worker_id", return_value="worker-a:1"):
        _heartbeat_loop_state(db, quorum_id, round_num=99)

    rows = db.rows("autonomy_loop_state")
    # round_num must NOT have been bumped to 99 by worker A.
    assert rows[0]["round_num"] != 99
    # worker_id must still be B.
    assert rows[0]["worker_id"] == "worker-b:2"


@pytest.mark.asyncio
async def test_lease_lost_during_iteration_exits_cleanly(db):
    """Inside the main loop, if another worker steals the lease, the iteration
    should observe `_lease_still_held() == False` and exit.

    We don't run `_run_quorum_loop` directly (it's an infinite loop) — instead
    we assert the primitive `_lease_still_held` returns False when the row's
    worker_id no longer matches us, which is what the loop checks each
    iteration.
    """
    from autonomy_loop import _lease_still_held, _worker_id

    quorum_id = "q-stolen-lease"

    # Seed a row that USED to be ours, then got stolen.
    db.seed(
        "autonomy_loop_state",
        [
            {
                "quorum_id": quorum_id,
                "status": "running",
                "worker_id": "thief-host:42",
                "autonomy_level": 0.5,
                "heartbeat_at": datetime.now(timezone.utc).isoformat(),
            }
        ],
    )

    assert _lease_still_held(db, quorum_id) is False
