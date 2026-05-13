"""Tests for the FacilitatorAgent (checklist 9.4).

Coverage:

1. Construction: ``facilitator_tool_names()`` returns the expected
   subset of 11.2's MCP tools.
2. ``MCPToolAdapter.call`` routes a tool name to the right FastMCP
   server and normalises the result.
3. ``observe()`` happy path: LLM returns valid JSON → typed
   ``FacilitatorObservation`` flows back with valid roles only.
4. ``observe()`` filters out hallucinated role_ids from
   ``referenced_role_ids``.
5. Error path: LLM returns malformed output → ``observe()`` returns
   ``None`` (caller skips this round).
6. ``run_and_broadcast()`` emits a ``facilitator_observation`` WS frame
   when ``observe()`` succeeds.
7. ``should_observe_this_round()`` cadence: every-3rd-round helper
   fires at the right rounds (1, 3, 6, 9, ...).
8. Integration: ``_run_autonomy_round`` emits a
   ``facilitator_observation`` frame when the cadence matches.
"""

from __future__ import annotations

import importlib
import json
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest


# ---------------------------------------------------------------------------
# Skip the whole module if the MCP SDK isn't installed — same gate
# test_mcp_servers.py uses.
# ---------------------------------------------------------------------------
pytest.importorskip("mcp.server.fastmcp")


# ---------------------------------------------------------------------------
# Wire ``apps.api.agents.facilitator`` into the bare ``agents`` slot, same
# pattern test_orchestrator.py uses — both modules live under
# ``apps/api/agents/`` and we want bare imports (``from agents.facilitator
# import observe``) to resolve to the same module object as the
# qualified imports.
# ---------------------------------------------------------------------------


def _install_apps_api_agents_as_bare() -> tuple[Any, Any, Any]:
    qualified_pkg = importlib.import_module("apps.api.agents")
    qualified_facilitator = importlib.import_module("apps.api.agents.facilitator")
    qualified_orchestrator = importlib.import_module("apps.api.agents.orchestrator")
    prior_pkg = sys.modules.get("agents")
    prior_facilitator = sys.modules.get("agents.facilitator")
    prior_orchestrator = sys.modules.get("agents.orchestrator")
    sys.modules["agents"] = qualified_pkg
    sys.modules["agents.facilitator"] = qualified_facilitator
    sys.modules["agents.orchestrator"] = qualified_orchestrator
    return prior_pkg, prior_facilitator, prior_orchestrator


def _restore_bare_agents(prior_pkg, prior_facilitator, prior_orchestrator) -> None:
    for name, prior in [
        ("agents", prior_pkg),
        ("agents.facilitator", prior_facilitator),
        ("agents.orchestrator", prior_orchestrator),
    ]:
        if prior is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = prior


@pytest.fixture(autouse=True)
def _bare_agents_alias():
    prior = _install_apps_api_agents_as_bare()
    try:
        yield
    finally:
        _restore_bare_agents(*prior)


# ---------------------------------------------------------------------------
# Fake Supabase-style db (mirrors test_mcp_servers.FakeDB so the real
# FastMCP servers we construct can read from it).
# ---------------------------------------------------------------------------


class _Result:
    def __init__(self, data: Any) -> None:
        self.data = data


class _FakeQuery:
    def __init__(self, rows: list[dict[str, Any]], table: str, store: dict) -> None:
        self._rows = list(rows)
        self._table = table
        self._store = store
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None
        self._pending_insert: dict | None = None
        self._pending_update: dict | None = None
        self._maybe_single = False
        self._lt: tuple[str, Any] | None = None

    def select(self, _cols: str = "*") -> "_FakeQuery":
        return self

    def eq(self, col: str, val: Any) -> "_FakeQuery":
        self._rows = [r for r in self._rows if r.get(col) == val]
        return self

    def lt(self, col: str, val: Any) -> "_FakeQuery":
        # No-op for the reaper pass — autonomy_loop calls .lt("claimed_at", ...)
        # which we don't actually need to filter on (test seeds have no
        # processing rows). Keep returning self so the chain completes.
        self._lt = (col, val)
        return self

    def order(self, col: str, desc: bool = False) -> "_FakeQuery":
        self._order = (col, desc)
        return self

    def limit(self, n: int) -> "_FakeQuery":
        self._limit = n
        return self

    def maybe_single(self) -> "_FakeQuery":
        self._maybe_single = True
        return self

    def insert(self, data: dict) -> "_FakeQuery":
        self._pending_insert = data
        return self

    def update(self, data: dict) -> "_FakeQuery":
        self._pending_update = data
        return self

    def execute(self) -> _Result:
        if self._pending_insert is not None:
            self._store.setdefault(self._table, []).append(self._pending_insert)
            return _Result([self._pending_insert])
        if self._pending_update is not None:
            # No-op update — return an empty data list so callers treat it
            # as "nothing matched". autonomy_loop's reaper-style updates
            # depend on this no-op safely returning.
            return _Result([])
        rows = list(self._rows)
        if self._order is not None:
            col, desc = self._order
            rows.sort(key=lambda r: (r.get(col) or 0), reverse=desc)
        if self._limit is not None:
            rows = rows[: self._limit]
        if self._maybe_single:
            return _Result(rows[0] if rows else None)
        return _Result(rows)


class FakeDB:
    def __init__(self) -> None:
        self._store: dict[str, list[dict[str, Any]]] = {}

    def table(self, name: str) -> _FakeQuery:
        return _FakeQuery(self._store.get(name, []), name, self._store)

    def seed(self, name: str, rows: list[dict[str, Any]]) -> None:
        self._store[name] = list(rows)


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


def _seed_db() -> FakeDB:
    """Two-role quorum with a few station_messages + insights for searching."""
    fake = FakeDB()
    fake.seed("quorums", [
        {"id": "q1", "title": "Phase III Rescue",
         "description": "Enrollment below target across 12 sites."},
    ])
    fake.seed("roles", [
        {"id": "r-pi", "quorum_id": "q1", "name": "PI",
         "authority_rank": 10, "capacity": "1", "status": "active"},
        {"id": "r-bs", "quorum_id": "q1", "name": "Biostatistician",
         "authority_rank": 5, "capacity": "1", "status": "active"},
    ])
    fake.seed("contributions", [
        {"id": "c1", "quorum_id": "q1", "role_id": "r-pi",
         "user_token": "u-pi",
         "content": "We need to add 4 sites to hit target.",
         "created_at": "2026-05-13T00:00:00Z"},
    ])
    fake.seed("station_messages", [
        {"id": "m1", "quorum_id": "q1",
         "content": "Sites are missing the enrollment target by 28%",
         "tags": ["enrollment", "risk"]},
        {"id": "m2", "quorum_id": "q1",
         "content": "Recommend a new site activation in EMEA",
         "tags": ["proposal", "sites"]},
    ])
    fake.seed("agent_insights", [
        {"id": "i1", "quorum_id": "q1",
         "content": "Three roles raised enrollment concerns this round",
         "tags": ["enrollment", "concern"]},
    ])
    return fake


@pytest.fixture
def db() -> FakeDB:
    return _seed_db()


@pytest.fixture
def ws_manager() -> MagicMock:
    m = MagicMock()
    m.broadcast = AsyncMock(return_value=None)
    m._connections = {"q1": {object(), object()}}
    return m


def _mock_llm(reply_text: str) -> MagicMock:
    """LLMProvider stub whose chat()/complete() both return ``reply_text``."""
    provider = MagicMock()
    provider.chat = AsyncMock(return_value=reply_text)
    provider.complete = AsyncMock(return_value=reply_text)
    return provider


# ---------------------------------------------------------------------------
# Test 1: tool surface
# ---------------------------------------------------------------------------


def test_facilitator_tool_surface_is_documented_subset():
    """The facilitator exposes the documented 7-tool subset of 11.2."""
    from agents.facilitator import facilitator_tool_names

    expected = {
        "get_quorum_state",
        "raise_question",
        "list_roles_by_quorum",
        "compare_authority",
        "search_messages",
        "search_insights",
        "broadcast",
    }
    assert set(facilitator_tool_names()) == expected


# ---------------------------------------------------------------------------
# Test 2: MCPToolAdapter routing + result normalisation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mcp_tool_adapter_routes_and_normalises(db, ws_manager):
    from apps.api.mcp_servers import build_all_servers
    from agents.facilitator import MCPToolAdapter

    servers = build_all_servers(db, ws_manager)
    adapter = MCPToolAdapter(servers)

    # Authority — list_roles_by_quorum returns list[dict]
    roles = await adapter.call("list_roles_by_quorum", {"quorum_id": "q1"})
    assert isinstance(roles, list)
    role_ids = [r["role_id"] for r in roles]
    assert {"r-pi", "r-bs"}.issubset(set(role_ids))

    # State — get_quorum_state returns dict
    state = await adapter.call("get_quorum_state", {"quorum_id": "q1"})
    assert isinstance(state, dict)
    assert state.get("quorum_id") == "q1"

    # Search — search_messages returns list[dict]
    msgs = await adapter.call(
        "search_messages", {"quorum_id": "q1", "query": "enrollment", "top_k": 5}
    )
    assert isinstance(msgs, list)

    # All routed calls recorded for introspection
    assert {c[0] for c in adapter.calls} == {
        "list_roles_by_quorum", "get_quorum_state", "search_messages",
    }


@pytest.mark.asyncio
async def test_mcp_tool_adapter_unknown_tool_returns_none(db, ws_manager):
    from apps.api.mcp_servers import build_all_servers
    from agents.facilitator import MCPToolAdapter

    adapter = MCPToolAdapter(build_all_servers(db, ws_manager))
    result = await adapter.call("does_not_exist", {})
    assert result is None


@pytest.mark.asyncio
async def test_mcp_tool_adapter_server_failure_returns_none(db, ws_manager):
    """If a server's tool raises, the adapter logs and returns None."""
    from apps.api.mcp_servers import build_all_servers
    from agents.facilitator import MCPToolAdapter

    servers = build_all_servers(db, ws_manager)
    adapter = MCPToolAdapter(servers)

    # Force a missing-arg ToolError by passing an empty quorum_id.
    result = await adapter.call("list_roles_by_quorum", {"quorum_id": ""})
    assert result is None


# ---------------------------------------------------------------------------
# Test 3: observe() happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_observe_returns_validated_observation(db, ws_manager):
    """LLM returns valid JSON → typed FacilitatorObservation flows back."""
    from apps.api.mcp_servers import build_all_servers
    from agents.facilitator import FacilitatorObservation, observe

    servers = build_all_servers(db, ws_manager)
    llm_json = json.dumps({
        "summary": "Three roles flagged enrollment risk; the biostat lead "
                   "hasn't weighed in yet.",
        "severity": "action_needed",
        "suggested_tool_calls": ["raise_question"],
        "referenced_role_ids": ["r-pi", "r-bs"],
    })
    observation = await observe("q1", servers, _mock_llm(llm_json))
    assert isinstance(observation, FacilitatorObservation)
    assert observation.severity == "action_needed"
    assert "enrollment" in observation.summary
    assert set(observation.referenced_role_ids) == {"r-pi", "r-bs"}
    assert observation.suggested_tool_calls == ["raise_question"]


@pytest.mark.asyncio
async def test_observe_filters_hallucinated_role_ids(db, ws_manager):
    """LLM's referenced_role_ids that aren't in the roster get dropped."""
    from apps.api.mcp_servers import build_all_servers
    from agents.facilitator import observe

    servers = build_all_servers(db, ws_manager)
    llm_json = json.dumps({
        "summary": "Convergence on a 2-arm RCT; endpoint choice remains open.",
        "severity": "notable",
        "suggested_tool_calls": [],
        "referenced_role_ids": ["r-pi", "r-PHANTOM"],
    })
    observation = await observe("q1", servers, _mock_llm(llm_json))
    assert observation is not None
    assert observation.referenced_role_ids == ["r-pi"]
    assert "r-PHANTOM" not in observation.referenced_role_ids


# ---------------------------------------------------------------------------
# Test 4: observe() returns None on malformed LLM output
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_observe_returns_none_on_malformed_json(db, ws_manager):
    """Bad JSON → None so the caller skips this round."""
    from apps.api.mcp_servers import build_all_servers
    from agents.facilitator import observe

    servers = build_all_servers(db, ws_manager)
    observation = await observe("q1", servers, _mock_llm("not valid json at all"))
    assert observation is None


@pytest.mark.asyncio
async def test_observe_returns_none_when_no_roles(ws_manager):
    """No active roles → nothing to observe → None."""
    from apps.api.mcp_servers import build_all_servers
    from agents.facilitator import observe

    empty_db = FakeDB()
    empty_db.seed("quorums", [{"id": "q1", "title": "Empty"}])
    # Note: NO roles seeded
    servers = build_all_servers(empty_db, ws_manager)
    obs = await observe("q1", servers, _mock_llm(
        json.dumps({"summary": "irrelevant", "severity": "info"})
    ))
    assert obs is None


@pytest.mark.asyncio
async def test_observe_accepts_markdown_fenced_json(db, ws_manager):
    """Tolerate ```json fences, same as the orchestrator."""
    from apps.api.mcp_servers import build_all_servers
    from agents.facilitator import observe

    servers = build_all_servers(db, ws_manager)
    raw = (
        "Here's the observation:\n"
        "```json\n"
        '{"summary": "Discussion is just getting started.",'
        '"severity": "info", "suggested_tool_calls": [],'
        '"referenced_role_ids": []}\n'
        "```\n"
    )
    obs = await observe("q1", servers, _mock_llm(raw))
    assert obs is not None
    assert obs.summary.startswith("Discussion")


# ---------------------------------------------------------------------------
# Test 5: run_and_broadcast emits a facilitator_observation WS frame
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_and_broadcast_emits_ws_frame(db, ws_manager):
    """End-to-end: observe + broadcast wraps the obs in a WS frame."""
    from agents.facilitator import run_and_broadcast

    llm_json = json.dumps({
        "summary": "Three roles flagged enrollment risk; IRB silent so far.",
        "severity": "action_needed",
        "suggested_tool_calls": ["raise_question"],
        "referenced_role_ids": ["r-pi"],
    })
    observation = await run_and_broadcast(
        quorum_id="q1",
        db=db,
        ws_manager=ws_manager,
        llm_provider=_mock_llm(llm_json),
        round_num=3,
    )
    assert observation is not None
    ws_manager.broadcast.assert_awaited()
    # Most-recent call should be the facilitator_observation frame.
    frames = [c.args[1] for c in ws_manager.broadcast.await_args_list]
    obs_frames = [f for f in frames if f.get("type") == "facilitator_observation"]
    assert obs_frames, (
        f"expected facilitator_observation frame; got types="
        f"{[f.get('type') for f in frames]}"
    )
    frame = obs_frames[-1]
    assert frame["summary"] == observation.summary
    assert frame["severity"] == "action_needed"
    assert frame["referenced_role_ids"] == ["r-pi"]
    assert frame["round"] == 3


@pytest.mark.asyncio
async def test_run_and_broadcast_returns_none_on_observe_failure(db, ws_manager):
    """observe() → None means we never broadcast."""
    from agents.facilitator import run_and_broadcast

    observation = await run_and_broadcast(
        quorum_id="q1",
        db=db,
        ws_manager=ws_manager,
        llm_provider=_mock_llm("not json"),
        round_num=3,
    )
    assert observation is None
    # No facilitator_observation frame ever emitted
    frames = [c.args[1] for c in ws_manager.broadcast.await_args_list]
    obs_frames = [f for f in frames if f.get("type") == "facilitator_observation"]
    assert obs_frames == []


# ---------------------------------------------------------------------------
# Test 6: cadence helper
# ---------------------------------------------------------------------------


def test_should_observe_default_cadence_is_every_3rd_round():
    """Default cadence: round 1 (initial framing), then every 3."""
    from agents.facilitator import (
        DEFAULT_OBSERVATION_EVERY_N_ROUNDS,
        should_observe_this_round,
    )

    assert DEFAULT_OBSERVATION_EVERY_N_ROUNDS == 3

    # Round 0: never (loop starts at 1)
    assert not should_observe_this_round(0)
    # Round 1: yes (first observation gives audience initial framing)
    assert should_observe_this_round(1)
    # Rounds 2: no
    assert not should_observe_this_round(2)
    # Round 3, 6, 9, 12 — yes
    for r in (3, 6, 9, 12, 15):
        assert should_observe_this_round(r), f"round {r} should fire"
    # Rounds 4, 5, 7, 8, 10, 11 — no
    for r in (4, 5, 7, 8, 10, 11):
        assert not should_observe_this_round(r), f"round {r} should NOT fire"


def test_should_observe_custom_cadence_n_equals_1_fires_every_round():
    from agents.facilitator import should_observe_this_round

    for r in range(1, 6):
        assert should_observe_this_round(r, every_n=1)


def test_should_observe_negative_round_is_safe():
    from agents.facilitator import should_observe_this_round

    assert not should_observe_this_round(-5)


# ---------------------------------------------------------------------------
# Test 7: autonomy_loop integration — facilitator_observation frame
# is emitted at the correct cadence.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_autonomy_round_emits_facilitator_observation_on_cadence(monkeypatch):
    """Round 3 (cadence match) emits a facilitator_observation frame.

    This is the integration assertion: when the autonomy_loop ticks a
    round that matches ``should_observe_this_round``, the
    ``run_and_broadcast`` helper should fire and emit the frame.
    """
    autonomy_loop = importlib.import_module("apps.api.autonomy_loop")

    # Pre-import the facilitator into the bare ``agents.facilitator`` slot
    # so the autonomy_loop's ``from agents.facilitator import ...`` resolves
    # to the same module our monkeypatch targets.
    facilitator_mod = importlib.import_module("apps.api.agents.facilitator")
    sys.modules["agents.facilitator"] = facilitator_mod

    # Stub run_and_broadcast so it always succeeds and is observable.
    call_args: list[dict] = []

    async def _stub_run_and_broadcast(
        *, quorum_id, db, ws_manager, llm_provider, round_num
    ):
        call_args.append({"quorum_id": quorum_id, "round_num": round_num})
        await ws_manager.broadcast(
            quorum_id,
            {
                "type": "facilitator_observation",
                "summary": "Stub observation from the test.",
                "severity": "info",
                "referenced_role_ids": [],
                "suggested_tool_calls": [],
                "round": round_num,
            },
        )
        from apps.api.agents.facilitator import FacilitatorObservation
        return FacilitatorObservation(summary="Stub observation from the test.")

    monkeypatch.setattr(
        facilitator_mod, "run_and_broadcast", _stub_run_and_broadcast, raising=True
    )

    # Stub the orchestrator so the round doesn't depend on LLM output.
    from agents.orchestrator import OrchestratorPlan

    stub_plan = OrchestratorPlan(
        next_speaker_role_id="r-bs",
        reason="biostat domain match",
        narration="Asking the biostat to weigh in on power.",
    )

    async def _stub_next_turn(qid, db, provider):
        return stub_plan

    monkeypatch.setattr(
        "agents.orchestrator.next_turn", _stub_next_turn, raising=True
    )

    # Capture ws_manager.broadcast frames.
    captured: list[dict] = []

    async def _capture_broadcast(qid, frame):
        captured.append({"qid": qid, "frame": frame})

    from ws_manager import manager as _ws_manager

    monkeypatch.setattr(_ws_manager, "broadcast", _capture_broadcast)

    # Stub process_agent_turn so the round completes.
    async def _stub_process_agent_turn(**kwargs):
        return ("ok reply", "msg-1", ["tag"])

    monkeypatch.setattr(
        "apps.api.agent_engine.process_agent_turn",
        _stub_process_agent_turn,
        raising=True,
    )

    # Force the proactive-turn branch to execute.
    monkeypatch.setattr(autonomy_loop.random, "random", lambda: 0.0)

    # Force A2A dispatch to return None so we fall back to direct.
    from quorum_a2a.a2a_client import A2AClient

    async def _no_a2a(self, role_id, message):
        return None

    monkeypatch.setattr(A2AClient, "send_message", _no_a2a, raising=True)

    db = _seed_db()
    # Adapt FakeDB to the orchestrator's read patterns (agent_configs,
    # station_messages with role/role_id/created_at) — the orchestrator
    # path is stubbed via _stub_next_turn so missing tables don't matter.

    # Round 3 should match cadence → observation broadcast.
    await autonomy_loop._run_autonomy_round(
        quorum_id="q1",
        autonomy_level=1.0,
        round_num=3,
        db=db,
        llm_provider=_mock_llm("{}"),
    )

    obs_frames = [
        c for c in captured
        if c["frame"].get("type") == "facilitator_observation"
    ]
    assert obs_frames, (
        f"expected facilitator_observation frame on round 3 cadence; "
        f"got types={[c['frame'].get('type') for c in captured]}"
    )
    assert obs_frames[0]["frame"]["round"] == 3
    # And the run_and_broadcast stub was called exactly once.
    assert call_args == [{"quorum_id": "q1", "round_num": 3}]


@pytest.mark.asyncio
async def test_autonomy_round_skips_observation_off_cadence(monkeypatch):
    """Round 2 (cadence miss) does NOT emit a facilitator_observation."""
    autonomy_loop = importlib.import_module("apps.api.autonomy_loop")
    facilitator_mod = importlib.import_module("apps.api.agents.facilitator")
    sys.modules["agents.facilitator"] = facilitator_mod

    fired = []

    async def _stub_run_and_broadcast(**kwargs):
        fired.append(kwargs)
        return None

    monkeypatch.setattr(
        facilitator_mod, "run_and_broadcast", _stub_run_and_broadcast, raising=True
    )

    # Stub orchestrator + process_agent_turn so the round completes.
    from agents.orchestrator import OrchestratorPlan

    async def _stub_next_turn(qid, db, provider):
        return OrchestratorPlan(
            next_speaker_role_id="r-bs", reason="x", narration="y."
        )

    monkeypatch.setattr(
        "agents.orchestrator.next_turn", _stub_next_turn, raising=True
    )

    async def _stub_process_agent_turn(**kwargs):
        return ("ok", "m1", [])

    monkeypatch.setattr(
        "apps.api.agent_engine.process_agent_turn",
        _stub_process_agent_turn,
        raising=True,
    )

    from quorum_a2a.a2a_client import A2AClient

    async def _no_a2a(self, role_id, message):
        return None

    monkeypatch.setattr(A2AClient, "send_message", _no_a2a, raising=True)

    captured: list[dict] = []

    async def _capture(qid, frame):
        captured.append(frame)

    from ws_manager import manager as _ws_manager

    monkeypatch.setattr(_ws_manager, "broadcast", _capture)

    monkeypatch.setattr(autonomy_loop.random, "random", lambda: 0.0)

    await autonomy_loop._run_autonomy_round(
        quorum_id="q1",
        autonomy_level=1.0,
        round_num=2,  # cadence MISS
        db=_seed_db(),
        llm_provider=_mock_llm("{}"),
    )

    # No facilitator_observation frame this round.
    obs_frames = [
        f for f in captured if f.get("type") == "facilitator_observation"
    ]
    assert obs_frames == []
    # And run_and_broadcast was never called.
    assert fired == []


# ---------------------------------------------------------------------------
# Test 8: log evidence that suggested_tool_calls is preserved in the WS frame
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_suggested_tool_calls_propagate_to_ws_frame(db, ws_manager):
    """The WS frame must include suggested_tool_calls for log transparency."""
    from agents.facilitator import run_and_broadcast

    llm_json = json.dumps({
        "summary": "Open question about consent has been quiet for 2 rounds.",
        "severity": "action_needed",
        "suggested_tool_calls": ["raise_question", "broadcast"],
        "referenced_role_ids": [],
    })
    await run_and_broadcast(
        quorum_id="q1",
        db=db,
        ws_manager=ws_manager,
        llm_provider=_mock_llm(llm_json),
        round_num=6,
    )
    frames = [c.args[1] for c in ws_manager.broadcast.await_args_list]
    obs_frame = next(
        f for f in frames if f.get("type") == "facilitator_observation"
    )
    assert obs_frame["suggested_tool_calls"] == ["raise_question", "broadcast"]
    assert obs_frame["severity"] == "action_needed"


# ---------------------------------------------------------------------------
# Test 9: example output for the report (analogous to orchestrator's
# test_next_turn_returns_an_example_plan_for_report).
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_observe_returns_example_for_report(db, ws_manager):
    """Prints a sample FacilitatorObservation for the PR body / final report."""
    from apps.api.mcp_servers import build_all_servers
    from agents.facilitator import observe

    servers = build_all_servers(db, ws_manager)
    llm_json = json.dumps({
        "summary": (
            "Three roles flagged enrollment as the central risk; the IRB "
            "officer hasn't weighed in for two rounds."
        ),
        "severity": "action_needed",
        "suggested_tool_calls": ["raise_question"],
        "referenced_role_ids": ["r-pi", "r-bs"],
    })
    observation = await observe("q1", servers, _mock_llm(llm_json))
    assert observation is not None
    print(f"\nEXAMPLE_OBSERVATION: {observation.model_dump_json()}")
