"""Tests for the Magentic-One style OrchestratorAgent (checklist 11.3).

Coverage:
1. ``next_turn()`` returns a validated OrchestratorPlan when the LLM
   responds with well-formed JSON.
2. The chosen ``next_speaker_role_id`` MUST be one of the active roles —
   defensive rejection when the LLM hallucinates a role_id.
3. Fallback path: when the LLM returns malformed JSON, ``next_turn()``
   returns None (so the autonomy loop can fall back to anti-monopoly
   random pick).
4. ``antimonopoly_random_pick`` never picks the role that spoke last
   (when at least one other role is active).
5. Integration: three consecutive ``next_turn()`` calls with a stub LLM
   that picks the lowest turn_counter role pick distinct roles
   (no-role-twice-in-a-row property holds).
"""

from __future__ import annotations

import importlib
import json
import random
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest


# ---------------------------------------------------------------------------
# Module setup — make ``agents.orchestrator`` resolvable via the bare name
#
# In production / dev, uvicorn is launched from inside ``apps/api/`` so the
# bare import ``from agents.orchestrator import ...`` (used in autonomy_loop)
# resolves to ``apps/api/agents/orchestrator.py``. Pytest, by contrast, runs
# from the project root, where Python finds the LEGACY ``agents/`` package at
# the repo root first (no orchestrator submodule). We install the
# ``apps.api.agents`` flavour into the bare slot here so both the autonomy_loop
# import and our own ``from agents.orchestrator import next_turn``
# refer to the same module object.
#
# Doing this in the test module (not conftest) keeps the side effect scoped:
# other tests that depend on the legacy root ``agents/`` (e.g. test_a2a_wakeup)
# still see what they expect.
# ---------------------------------------------------------------------------


def _install_apps_api_agents_as_bare() -> None:
    """Alias ``apps.api.agents{.orchestrator}`` into the bare ``agents`` slot.

    Snapshots whatever was there so we can restore it on teardown.
    """
    qualified_pkg = importlib.import_module("apps.api.agents")
    qualified_sub = importlib.import_module("apps.api.agents.orchestrator")
    prior_pkg = sys.modules.get("agents")
    prior_sub = sys.modules.get("agents.orchestrator")
    sys.modules["agents"] = qualified_pkg
    sys.modules["agents.orchestrator"] = qualified_sub
    return prior_pkg, prior_sub


def _restore_bare_agents(prior_pkg, prior_sub) -> None:
    """Restore whatever ``agents`` / ``agents.orchestrator`` was before the install.

    If nothing was there before, remove the aliases entirely so the legacy
    root-level ``agents/`` package can be re-discovered by other tests.
    """
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
    """Per-test fixture that wires apps.api.agents into the bare slot.

    Scoped to a single test so other test files that depend on the legacy
    root ``agents/`` package don't see a swapped module after this file runs.
    """
    prior = _install_apps_api_agents_as_bare()
    try:
        yield
    finally:
        _restore_bare_agents(*prior)


# ---------------------------------------------------------------------------
# Fake Supabase tailored to the orchestrator's reads
# ---------------------------------------------------------------------------


class _Result:
    def __init__(self, data):
        self.data = data


class _Chain:
    def __init__(self, table_name: str, store: dict):
        self._t = table_name
        self._store = store
        self._filters: list[tuple[str, Any]] = []
        self._order_desc = True
        self._limit: int | None = None
        self._maybe_single = False

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, col: str, val: Any):
        self._filters.append((col, val))
        return self

    def order(self, _col: str, desc: bool = True):
        self._order_desc = desc
        return self

    def limit(self, n: int):
        self._limit = n
        return self

    def maybe_single(self):
        self._maybe_single = True
        return self

    def execute(self):
        rows = list(self._store.get(self._t, []))
        for col, val in self._filters:
            rows = [r for r in rows if r.get(col) == val]
        # Crude order: assume rows are already in insertion order; reverse if desc
        if self._order_desc:
            rows = list(reversed(rows))
        if self._limit is not None:
            rows = rows[: self._limit]
        if self._maybe_single:
            return _Result(rows[0] if rows else None)
        return _Result(rows)


class _FakeDB:
    def __init__(self, store: dict):
        self._store = store

    def table(self, name: str):
        return _Chain(name, self._store)


def _seed_store() -> dict:
    """Two-role quorum with one prior assistant turn from role-a."""
    return {
        "quorums": [
            {
                "id": "q1",
                "title": "Phase III enrollment rescue",
                "description": "Sites under target.",
            }
        ],
        "roles": [
            {"id": "role-a", "name": "Biostatistician", "status": "active", "quorum_id": "q1", "authority_rank": 3},
            {"id": "role-b", "name": "IRB Officer", "status": "active", "quorum_id": "q1", "authority_rank": 4},
            {"id": "role-c", "name": "Site Coordinator", "status": "inactive", "quorum_id": "q1", "authority_rank": 2},
        ],
        "agent_configs": [
            {"role_id": "role-a", "quorum_id": "q1", "domain_tags": ["statistics", "power", "sample_size"]},
            {"role_id": "role-b", "quorum_id": "q1", "domain_tags": ["irb", "consent", "compliance"]},
        ],
        "station_messages": [
            # The most recent assistant message is from role-a.
            {
                "role_id": "role-a",
                "role": "assistant",
                "content": "I'm worried about statistical power at 47% enrollment.",
                "quorum_id": "q1",
                "created_at": "2026-05-12T10:00:00Z",
            },
        ],
        "agent_insights": [],
    }


def _mock_llm(reply_text: str):
    """Build a MagicMock LLMProvider whose chat() returns reply_text."""
    provider = MagicMock()
    provider.chat = AsyncMock(return_value=reply_text)
    provider.complete = AsyncMock(return_value=reply_text)
    return provider


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_next_turn_returns_validated_plan():
    """Happy path: LLM returns valid JSON; we get a typed plan back."""
    from agents.orchestrator import next_turn

    db = _FakeDB(_seed_store())
    plan_json = json.dumps(
        {
            "next_speaker_role_id": "role-b",
            "reason": "IRB has not weighed in on the consent question",
            "narration": "Asking the IRB officer to weigh in on the consent question.",
        }
    )
    plan = await next_turn("q1", db, _mock_llm(plan_json))
    assert plan is not None
    assert plan.next_speaker_role_id == "role-b"
    assert "IRB" in plan.reason or "consent" in plan.reason
    assert plan.narration.endswith(".")


@pytest.mark.asyncio
async def test_next_turn_rejects_hallucinated_role_id():
    """Defensive: LLM picks a role_id that isn't in the active set → None."""
    from agents.orchestrator import next_turn

    db = _FakeDB(_seed_store())
    plan_json = json.dumps(
        {
            "next_speaker_role_id": "role-DOES-NOT-EXIST",
            "reason": "anything",
            "narration": "Asking nobody, this should not happen.",
        }
    )
    plan = await next_turn("q1", db, _mock_llm(plan_json))
    assert plan is None


@pytest.mark.asyncio
async def test_next_turn_returns_none_on_malformed_json():
    """Fallback path: bad JSON → None so caller can do random pick."""
    from agents.orchestrator import next_turn

    db = _FakeDB(_seed_store())
    plan = await next_turn("q1", db, _mock_llm("not json at all"))
    assert plan is None


@pytest.mark.asyncio
async def test_next_turn_accepts_markdown_fenced_json():
    """Many models prefix ```json fences despite the no-fences instruction."""
    from agents.orchestrator import next_turn

    db = _FakeDB(_seed_store())
    raw = (
        "Here is the plan:\n"
        "```json\n"
        '{"next_speaker_role_id":"role-a","reason":"because","narration":"Asking role-a."}\n'
        "```\n"
    )
    plan = await next_turn("q1", db, _mock_llm(raw))
    assert plan is not None
    assert plan.next_speaker_role_id == "role-a"


@pytest.mark.asyncio
async def test_next_turn_skips_inactive_roles_from_validation():
    """Even though role-c is in the table, status=inactive excludes it."""
    from agents.orchestrator import next_turn

    db = _FakeDB(_seed_store())
    # The LLM picks the inactive role — should be rejected.
    plan_json = json.dumps(
        {
            "next_speaker_role_id": "role-c",
            "reason": "site coordinator could chime in",
            "narration": "Asking the site coordinator.",
        }
    )
    plan = await next_turn("q1", db, _mock_llm(plan_json))
    assert plan is None


@pytest.mark.asyncio
async def test_next_turn_returns_none_when_no_active_roles():
    """No active roles → orchestrator can't pick anyone → None."""
    from agents.orchestrator import next_turn

    store = _seed_store()
    for r in store["roles"]:
        r["status"] = "inactive"
    db = _FakeDB(store)
    plan = await next_turn("q1", db, _mock_llm(json.dumps({})))
    assert plan is None


def test_antimonopoly_random_pick_avoids_last_speaker():
    """Among multiple active roles, never pick the last speaker."""
    from agents.orchestrator import antimonopoly_random_pick

    roles = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
    # Deterministic RNG so we can prove the avoidance, not just probabilistically.
    rng = random.Random(0)
    picks = [
        antimonopoly_random_pick(roles, last_speaker_id="a", rng=rng)["id"]
        for _ in range(50)
    ]
    assert "a" not in picks


def test_antimonopoly_random_pick_single_role_returns_it():
    """Degenerate case: only one role active → pick it even if it just spoke."""
    from agents.orchestrator import antimonopoly_random_pick

    roles = [{"id": "only"}]
    result = antimonopoly_random_pick(roles, last_speaker_id="only")
    assert result["id"] == "only"


@pytest.mark.asyncio
async def test_three_round_integration_no_repeat_speakers():
    """3 sequential next_turn() calls — stub LLM picks the lowest-turn-counter role.

    Property under test: across 3 rounds no role speaks twice in a row.
    This is the anti-monopoly property called out in the spec.
    """
    from agents.orchestrator import next_turn

    store = _seed_store()
    # Start with no assistant messages — every role's turn counter is 0.
    store["station_messages"] = []
    db = _FakeDB(store)

    # Hand-rolled "smart" LLM: parse the user content for turn_counter lines
    # and pick the active role with the smallest count. Tie-breaking by id.
    def _build_llm_response(content: str) -> str:
        # Parse role lines: "  - id=X name=...possibly multi-word... turn_counter=K tags=[...]"
        # Anchor on the "id=" and "turn_counter=" tokens with arbitrary text between
        # so role names with spaces (e.g. "IRB Officer") parse correctly.
        import re

        candidates: list[tuple[int, str]] = []
        for m in re.finditer(r"id=(\S+).*?turn_counter=(\d+)", content):
            rid, count = m.group(1), int(m.group(2))
            candidates.append((count, rid))
        # Sort by (count, id) so ties break deterministically.
        candidates.sort()
        rid = candidates[0][1] if candidates else "role-a"
        return json.dumps(
            {
                "next_speaker_role_id": rid,
                "reason": f"lowest turn_counter ({candidates[0][0]})",
                "narration": f"Asking {rid} to take the next turn.",
            }
        )

    async def _smart_chat(messages, _tier):
        # The user content is the last message; respond based on it.
        user_content = messages[-1]["content"]
        return _build_llm_response(user_content)

    provider = MagicMock()
    provider.chat = _smart_chat
    provider.complete = _smart_chat

    last_speaker: str | None = None
    chosen_history: list[str] = []
    for round_idx in range(3):
        plan = await next_turn("q1", db, provider)
        assert plan is not None, f"round {round_idx}: plan was None"
        assert plan.next_speaker_role_id != last_speaker, (
            f"round {round_idx}: same speaker as previous round ({last_speaker})"
        )
        chosen_history.append(plan.next_speaker_role_id)

        # Simulate the chosen role speaking — append a station_messages row.
        store["station_messages"].append(
            {
                "role_id": plan.next_speaker_role_id,
                "role": "assistant",
                "content": "I have spoken on this turn.",
                "quorum_id": "q1",
                "created_at": f"2026-05-12T10:0{round_idx}:00Z",
            }
        )
        last_speaker = plan.next_speaker_role_id

    # 2 active roles, 3 rounds → at least 2 distinct speakers, and we already
    # verified no consecutive repeats.
    assert len(set(chosen_history)) >= 2


@pytest.mark.asyncio
async def test_next_turn_returns_an_example_plan_for_report():
    """Print an example OrchestratorPlan so the spec's "example plan" section
    of the final report can quote a real value rather than a hypothetical."""
    from agents.orchestrator import next_turn

    db = _FakeDB(_seed_store())
    plan_json = json.dumps(
        {
            "next_speaker_role_id": "role-b",
            "reason": (
                "Anti-monopoly: role-a just spoke. role-b's domain "
                "(irb, consent, compliance) matches the open question about "
                "consent language for the protocol amendment."
            ),
            "narration": (
                "Asking the IRB officer to review the revised consent "
                "language for the protocol amendment."
            ),
        }
    )
    plan = await next_turn("q1", db, _mock_llm(plan_json))
    assert plan is not None
    print(f"\nEXAMPLE_PLAN: {plan.model_dump_json()}")


# ---------------------------------------------------------------------------
# Autonomy-loop integration: verify a facilitator_narration WS frame is emitted
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_autonomy_round_broadcasts_facilitator_narration(monkeypatch):
    """One round of _run_autonomy_round emits a facilitator_narration WS frame.

    The test wires the orchestrator stub (returning a known plan) and a
    captured ws_manager.broadcast, then drives a single round. We assert at
    least one broadcast carries ``type=facilitator_narration`` with the
    correct ``next_role_id`` and ``narration`` fields.
    """
    import importlib

    autonomy_loop = importlib.import_module("apps.api.autonomy_loop")

    # Stub the orchestrator to return a deterministic plan.
    from agents.orchestrator import OrchestratorPlan

    stub_plan = OrchestratorPlan(
        next_speaker_role_id="role-b",
        reason="role-b's IRB domain matches the open consent question",
        narration="Asking the IRB officer about the revised consent language.",
    )

    async def _stub_next_turn(qid, db, provider):
        assert qid == "q1"
        return stub_plan

    monkeypatch.setattr(
        "agents.orchestrator.next_turn", _stub_next_turn, raising=True
    )

    # Capture broadcast frames and short-circuit downstream side effects.
    # The autonomy_loop calls ``manager.broadcast(qid, frame)`` on a singleton
    # ``manager`` imported from ws_manager. Patching the bound method on the
    # instance is the cleanest interception point.
    captured_frames: list[dict] = []

    async def _capture_broadcast(qid, frame):
        captured_frames.append({"qid": qid, "frame": frame})

    from ws_manager import manager as _ws_manager

    monkeypatch.setattr(_ws_manager, "broadcast", _capture_broadcast)

    # Mock process_agent_turn so the round completes without doing a real LLM call.
    async def _stub_process_agent_turn(**kwargs):
        return ("ok reply", "msg-1", ["sample_tag"])

    monkeypatch.setattr(
        "apps.api.agent_engine.process_agent_turn",
        _stub_process_agent_turn,
        raising=True,
    )

    # Force a deterministic "proactive turn fires this round" by patching
    # random.random to return 0.0 (so 0 > 1.0 is False, turn fires).
    monkeypatch.setattr(autonomy_loop.random, "random", lambda: 0.0)

    # Force A2A to return None so the loop falls through to direct dispatch
    # (avoids needing a running uvicorn).
    from quorum_a2a.a2a_client import A2AClient

    async def _no_endpoint(self, role_id, message):
        return None

    monkeypatch.setattr(A2AClient, "send_message", _no_endpoint, raising=True)

    db = _FakeDB(_seed_store())

    # llm_provider just needs to be a MagicMock — process_agent_turn is stubbed
    # and orchestrator next_turn is stubbed.
    provider = _mock_llm(json.dumps({}))

    await autonomy_loop._run_autonomy_round(
        quorum_id="q1",
        autonomy_level=1.0,  # ensure proactive-turn phase runs
        round_num=2,
        db=db,
        llm_provider=provider,
    )

    narration_frames = [
        c for c in captured_frames
        if c["frame"].get("type") == "facilitator_narration"
    ]
    assert narration_frames, (
        f"expected at least one facilitator_narration frame, "
        f"got types={[c['frame'].get('type') for c in captured_frames]}"
    )
    frame = narration_frames[0]["frame"]
    assert frame["narration"] == stub_plan.narration
    assert frame["next_role_id"] == "role-b"
    assert frame.get("reason") == stub_plan.reason
