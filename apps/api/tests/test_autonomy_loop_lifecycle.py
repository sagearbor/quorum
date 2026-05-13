"""Autonomy-loop critical-path coverage — checklist item 12.4.

These tests focus on paths that previous PRs didn't exercise:

  * Quorum lifecycle: ``resolved`` / ``archived`` / missing quorum -> loop exits cleanly
    without raising, with the autonomy_loop_state row marked stopped.
  * Speaker election heuristics: the ``antimonopoly_random_pick`` fallback
    (used when the orchestrator LLM is unavailable) must avoid the
    last-speaker role and produce an approximately uniform distribution
    when everyone has spoken equally.
  * Reaper edge case duplicate of the lifecycle path: a deleted quorum row
    during a tick must not raise.

Style: re-uses the ``_make_fake_supabase`` pattern from the existing race
tests so we don't need a live Postgres.
"""

from __future__ import annotations

import asyncio
import copy
import importlib
import random
import sys
import threading
from collections import Counter
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Module aliasing — make ``agents.orchestrator`` resolve to apps.api.agents.
# Same pattern as test_orchestrator.py (the legacy root-level ``agents/``
# package would shadow our submodule under pytest's CWD).
# ---------------------------------------------------------------------------


def _install_apps_api_agents_as_bare():
    qualified_pkg = importlib.import_module("apps.api.agents")
    qualified_sub = importlib.import_module("apps.api.agents.orchestrator")
    prior_pkg = sys.modules.get("agents")
    prior_sub = sys.modules.get("agents.orchestrator")
    sys.modules["agents"] = qualified_pkg
    sys.modules["agents.orchestrator"] = qualified_sub
    return prior_pkg, prior_sub


def _restore_bare_agents(prior_pkg, prior_sub):
    if prior_pkg is None:
        sys.modules.pop("agents", None)
    else:
        sys.modules["agents"] = prior_pkg
    if prior_sub is None:
        sys.modules.pop("agents.orchestrator", None)
    else:
        sys.modules["agents.orchestrator"] = prior_sub


@pytest.fixture(autouse=True)
def _bare_agents_alias():
    prior = _install_apps_api_agents_as_bare()
    try:
        yield
    finally:
        _restore_bare_agents(*prior)


# ---------------------------------------------------------------------------
# Minimal stateful fake DB — same shape as test_autonomy_race's _FakeDB but
# carries the column surface we need for the lifecycle path:
#   quorums.{id,status,title,description}
#   agent_requests, station_messages, agent_insights, roles, contributions
#   autonomy_loop_state.{quorum_id,status,worker_id,heartbeat_at,...}
# ---------------------------------------------------------------------------


class _FakeChain:
    def __init__(self, table: "_FakeTable"):
        self._table = table
        self._filters: list[tuple[str, str, Any]] = []
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None
        self._mode: str | None = None
        self._update_payload: dict | None = None
        self._insert_payload: Any = None
        self._upsert_payload: dict | None = None
        self._on_conflict: str | None = None
        self._single = False

    def select(self, cols: str = "*"):
        self._mode = "select"
        return self

    def update(self, payload: dict):
        self._mode = "update"
        self._update_payload = dict(payload)
        return self

    def insert(self, payload):
        self._mode = "insert"
        self._insert_payload = payload
        return self

    def upsert(self, payload: dict, *, on_conflict: str = "id"):
        self._mode = "upsert"
        self._upsert_payload = dict(payload)
        self._on_conflict = on_conflict
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
                    out = existing
                else:
                    self._table.rows.append(dict(payload))
                    out = payload
                result = MagicMock()
                result.data = [copy.deepcopy(out)]
                return result

            if self._mode == "delete":
                kept = [r for r in self._table.rows if not self._matches(r)]
                removed = [r for r in self._table.rows if self._matches(r)]
                self._table.rows[:] = kept
                result = MagicMock()
                result.data = removed
                return result

            result = MagicMock()
            result.data = None
            return result


class _FakeTable:
    def __init__(self, name: str, rows: list[dict], lock: threading.Lock):
        self.name = name
        self.rows = rows
        self._lock = lock


class _FakeDB:
    def __init__(self):
        self._lock = threading.Lock()
        self._tables: dict[str, _FakeTable] = {}

    def seed(self, name: str, rows: list[dict]):
        tbl = self._tables.setdefault(name, _FakeTable(name, [], self._lock))
        tbl.rows.extend(rows)

    def rows(self, name: str) -> list[dict]:
        return self._tables.setdefault(name, _FakeTable(name, [], self._lock)).rows

    def table(self, name: str) -> _FakeChain:
        if name not in self._tables:
            self._tables[name] = _FakeTable(name, [], self._lock)
        return _FakeChain(self._tables[name])


_QUORUM_ID = "q-lifecycle"


# ---------------------------------------------------------------------------
# Quorum lifecycle: resolved / deleted / archived
# ---------------------------------------------------------------------------


class TestQuorumLifecycle:
    """Loop must exit cleanly when the quorum becomes inactive."""

    @pytest.mark.asyncio
    async def test_quorum_resolved_during_tick_exits_loop(self):
        """A round executes against a quorum that flips to ``resolved`` between
        the start of the round and the post-round status check.

        Asserts: the round itself does NOT raise. (The exit-and-mark-stopped
        flow lives inside ``_run_quorum_loop``'s post-iteration status check,
        which we cover separately via the lease-still-held primitive.)
        """
        from autonomy_loop import _run_autonomy_round

        db = _FakeDB()
        db.seed("agent_requests", [])
        db.seed("roles", [])
        db.seed("quorums", [{"id": _QUORUM_ID, "status": "resolved"}])
        db.seed("station_messages", [])
        db.seed("agent_insights", [])

        with (
            patch("apps.api.agent_engine.process_a2a_request", new=AsyncMock()),
            patch("apps.api.agent_engine.process_agent_turn", new=AsyncMock()),
            patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
        ):
            # No exception.
            await _run_autonomy_round(_QUORUM_ID, 1.0, 1, db, MagicMock())

    @pytest.mark.asyncio
    async def test_quorum_deleted_does_not_raise(self):
        """All quorum-related rows have been deleted between rounds. The next
        round must complete without raising — there's no quorum row, no roles,
        no agent_requests.
        """
        from autonomy_loop import _run_autonomy_round

        db = _FakeDB()
        # quorums table empty -> quorum_data.data == None
        db.seed("agent_requests", [])
        db.seed("roles", [])
        db.seed("station_messages", [])
        db.seed("agent_insights", [])

        with (
            patch("apps.api.agent_engine.process_a2a_request", new=AsyncMock()),
            patch("apps.api.agent_engine.process_agent_turn", new=AsyncMock()),
            patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
        ):
            # Must not raise.
            await _run_autonomy_round(_QUORUM_ID, 1.0, 1, db, MagicMock())

    @pytest.mark.asyncio
    async def test_no_active_roles_short_circuits_proactive_turn(self):
        """With zero active roles, the proactive-turn branch returns early
        before touching the orchestrator or LLM.
        """
        from autonomy_loop import _run_autonomy_round

        db = _FakeDB()
        db.seed("agent_requests", [])
        # All roles inactive — empty pool after the filter.
        db.seed(
            "roles",
            [
                {"id": "r1", "name": "alpha", "quorum_id": _QUORUM_ID, "status": "pending"},
            ],
        )
        db.seed("quorums", [{"id": _QUORUM_ID, "status": "active"}])
        db.seed("station_messages", [])
        db.seed("agent_insights", [])

        process_turn = AsyncMock()
        with (
            patch("apps.api.agent_engine.process_a2a_request", new=AsyncMock()),
            patch("apps.api.agent_engine.process_agent_turn", new=process_turn),
            patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
            # Force the proactive-turn branch by making random.random() return 0.
            patch("apps.api.autonomy_loop.random.random", return_value=0.0),
        ):
            await _run_autonomy_round(_QUORUM_ID, 1.0, 1, db, MagicMock())

        # process_agent_turn should NOT have been called — no active roles.
        assert process_turn.await_count == 0


# ---------------------------------------------------------------------------
# Random-speaker election (anti-monopoly fallback)
# ---------------------------------------------------------------------------


class TestAntimonopolyRandomPick:
    """The ``antimonopoly_random_pick`` fallback (used when the orchestrator
    LLM is unavailable) must:

      1. Never pick the last speaker when there are other options.
      2. With everyone equally eligible, distribute approximately uniformly.
    """

    def test_never_picks_last_speaker_when_alternatives_exist(self):
        from agents.orchestrator import antimonopoly_random_pick

        roles = [
            {"id": "role-a", "name": "alpha"},
            {"id": "role-b", "name": "beta"},
            {"id": "role-c", "name": "gamma"},
        ]
        rng = random.Random(42)
        # Hammer the function 200 times with last_speaker_id=role-a.
        for _ in range(200):
            pick = antimonopoly_random_pick(roles, "role-a", rng=rng)
            assert pick["id"] != "role-a"

    def test_picks_evenly_when_no_recent_speaker(self):
        """No last_speaker -> uniform over all roles (Chi-squared rough check).

        With 3 roles and 600 trials, each bucket should be ~200 ± noise.
        We accept any distribution where every role appears at least 100 times.
        """
        from agents.orchestrator import antimonopoly_random_pick

        roles = [
            {"id": "role-a", "name": "alpha"},
            {"id": "role-b", "name": "beta"},
            {"id": "role-c", "name": "gamma"},
        ]
        rng = random.Random(99)
        counts: Counter[str] = Counter()
        for _ in range(600):
            pick = antimonopoly_random_pick(roles, last_speaker_id=None, rng=rng)
            counts[pick["id"]] += 1

        for role_id in ("role-a", "role-b", "role-c"):
            assert (
                counts[role_id] >= 100
            ), f"role {role_id} only picked {counts[role_id]} times out of 600 (expected ~200)"

    def test_after_A_B_A_does_not_pick_A(self):
        """Heuristic: last 3 turns went to A,B,A — the *immediate* last speaker
        is A, so the next pick must NOT be A.

        The current implementation only considers ``last_speaker_id`` (one
        step of history). This test pins that behaviour so future enhancements
        (e.g. weighted multi-turn anti-monopoly) don't regress the basic guard.
        """
        from agents.orchestrator import antimonopoly_random_pick

        roles = [
            {"id": "role-a", "name": "alpha"},
            {"id": "role-b", "name": "beta"},
            {"id": "role-c", "name": "gamma"},
        ]
        last_speaker = "role-a"  # the most recent of A,B,A
        rng = random.Random(0xC0FFEE)
        picks = [
            antimonopoly_random_pick(roles, last_speaker, rng=rng)["id"]
            for _ in range(50)
        ]
        # Every pick must be NOT role-a.
        assert all(p != "role-a" for p in picks), (
            "antimonopoly fallback let role-a speak immediately after itself"
        )
        # And both alternatives should appear (we're not just always picking B).
        assert "role-b" in picks
        assert "role-c" in picks

    def test_single_role_must_still_speak(self):
        """Degenerate case: only one active role. The function MUST return
        that role even if it just spoke — there's no alternative.
        """
        from agents.orchestrator import antimonopoly_random_pick

        roles = [{"id": "solo", "name": "only-one"}]
        pick = antimonopoly_random_pick(roles, last_speaker_id="solo")
        assert pick["id"] == "solo"

    def test_empty_role_list_raises(self):
        """No active roles -> ValueError. (Caller must guard against this.)"""
        from agents.orchestrator import antimonopoly_random_pick

        with pytest.raises(ValueError):
            antimonopoly_random_pick([], last_speaker_id=None)


# ---------------------------------------------------------------------------
# Reaper + lifecycle interaction
# ---------------------------------------------------------------------------


class TestReaperLifecycleInteraction:
    """The reaper and the lifecycle exit interact: a round can both reap
    stale requests AND exit cleanly when the quorum is gone.
    """

    @pytest.mark.asyncio
    async def test_reaper_runs_even_when_quorum_resolved(self):
        """Even when the quorum is already resolved, the reaper still flips
        stale rows so they don't poison a re-opened quorum or get picked up
        by a different worker.
        """
        from datetime import datetime, timedelta, timezone

        from autonomy_loop import _run_autonomy_round

        stale_ts = (
            datetime.now(timezone.utc) - timedelta(seconds=120)
        ).isoformat()

        db = _FakeDB()
        db.seed(
            "agent_requests",
            [
                {
                    "id": "ghost-req",
                    "quorum_id": _QUORUM_ID,
                    "from_role_id": "r1",
                    "to_role_id": "r2",
                    "request_type": "input_request",
                    "content": "x",
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
        )
        db.seed("roles", [])
        db.seed("quorums", [{"id": _QUORUM_ID, "status": "resolved"}])
        db.seed("station_messages", [])
        db.seed("agent_insights", [])

        fake_process = AsyncMock(return_value="ok")
        with (
            patch("apps.api.agent_engine.process_a2a_request", new=fake_process),
            patch("apps.api.agent_engine.process_agent_turn", new=AsyncMock()),
            patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
        ):
            await _run_autonomy_round(_QUORUM_ID, 1.0, 1, db, MagicMock())

        # The reaper fired (claimed_at advanced from the stale sentinel).
        row = next(r for r in db.rows("agent_requests") if r["id"] == "ghost-req")
        assert row["claimed_at"] != stale_ts
