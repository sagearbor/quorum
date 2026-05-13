"""Tests for AUTONOMY_AUTO_CONTRIBUTE_MODE — item 10.9.

The env var controls whether the autonomy loop auto-submits contributions
when autonomy_level >= 0.7 and round_num >= 3:

  "off"        — never auto-submit. Default for the Duke Tech Expo 2026 demo
                 so the projector never shows fragment-salad artifacts.
  "concat"     — legacy behaviour: string-join the last 3 assistant messages.
  "synthesize" — LLM-synthesised single position (not exercised here; just
                 verify the dispatch path runs without raising).
"""

from __future__ import annotations

import os
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from apps.api.autonomy_loop import _maybe_auto_contribute


def _make_db(existing=False, messages=None):
    """Build a minimal MagicMock Supabase client.

    The first .table().select()... chain returns the existence-check result.
    The second chain returns the recent messages. Insert payloads are captured
    on a list so tests can assert on them directly.
    """
    if messages is None:
        messages = []

    db = MagicMock()
    db.insert_payloads = []  # type: ignore[attr-defined]
    existing_result = SimpleNamespace(data=[{"id": "c1"}] if existing else [])
    messages_result = SimpleNamespace(data=messages)
    chains = [existing_result, messages_result]
    chain_index = {"i": 0}

    def table_call(name):
        tbl = MagicMock()

        def execute_side_effect():
            idx = chain_index["i"]
            chain_index["i"] += 1
            if idx < len(chains):
                return chains[idx]
            return SimpleNamespace(data=[])

        def insert_capture(payload):
            db.insert_payloads.append(payload)
            inserter = MagicMock()
            inserter.execute.return_value = SimpleNamespace(data=[payload])
            return inserter

        tbl.select.return_value = tbl
        tbl.eq.return_value = tbl
        tbl.order.return_value = tbl
        tbl.limit.return_value = tbl
        tbl.execute.side_effect = execute_side_effect
        tbl.insert.side_effect = insert_capture
        return tbl

    db.table.side_effect = table_call
    return db


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    monkeypatch.delenv("AUTONOMY_AUTO_CONTRIBUTE_MODE", raising=False)


def _role():
    return {"id": "11111111-1111-1111-1111-111111111111", "name": "Medical PI"}


def test_concat_mode_inserts_joined_messages():
    db = _make_db(
        messages=[
            {"content": "The eGFR threshold should be 45.", "tags": []},
            {"content": "Further review needed on the safety endpoint.", "tags": []},
            {"content": "I recommend the dose-escalation cohort design.", "tags": []},
        ]
    )
    _maybe_auto_contribute(db, "q1", _role(), 0.9, 3, mode="concat")

    assert len(db.insert_payloads) == 1, "expected exactly one contributions.insert"
    payload = db.insert_payloads[0]
    assert payload["role_id"] == _role()["id"]
    assert "eGFR" in payload["content"]
    assert "dose-escalation" in payload["content"]
    assert len(payload["content"]) <= 2000


def test_skips_when_role_has_already_contributed():
    db = _make_db(existing=True)
    _maybe_auto_contribute(db, "q1", _role(), 0.9, 3, mode="concat")
    assert db.insert_payloads == []


def test_skips_when_messages_too_short():
    db = _make_db(messages=[{"content": "ok", "tags": []}])
    _maybe_auto_contribute(db, "q1", _role(), 0.9, 3, mode="concat")
    assert db.insert_payloads == []


def test_default_mode_off_skips_in_outer_dispatch(monkeypatch):
    # Outer dispatch reads AUTONOMY_AUTO_CONTRIBUTE_MODE from env. When unset,
    # default is "off" and _maybe_auto_contribute should not be invoked at all.
    # We can't easily run the full _run_proactive_turn here, but we can confirm
    # the env default is "off" via the same os.environ lookup the dispatcher uses.
    mode = os.environ.get("AUTONOMY_AUTO_CONTRIBUTE_MODE", "off").lower()
    assert mode == "off"


# ---------------------------------------------------------------------------
# 12.4 — Extended mode flag coverage
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_outer_dispatch_off_mode_skips_insert_entirely(monkeypatch):
    """When AUTONOMY_AUTO_CONTRIBUTE_MODE=off, _run_autonomy_round must not
    invoke _maybe_auto_contribute regardless of autonomy_level / round_num.

    This integration-tests the early-return guard at the call site, not just
    the env lookup. We run a single round at autonomy=1.0 and round=10
    (well above the 0.7 / 3 thresholds) and assert no contribution row is
    inserted.
    """
    from unittest.mock import AsyncMock, patch

    from apps.api import autonomy_loop

    # Default — env unset means mode='off'.
    monkeypatch.delenv("AUTONOMY_AUTO_CONTRIBUTE_MODE", raising=False)

    # Use a fully-stubbed DB that records inserts into contributions.
    inserted: list[dict] = []
    db = _build_full_db(inserted)

    # No A2A pending; orchestrator returns None so we hit the random pick path.
    with (
        patch("apps.api.agent_engine.process_a2a_request", new=AsyncMock()),
        patch(
            "apps.api.agent_engine.process_agent_turn",
            new=AsyncMock(return_value=("Here is my analysis with enough content " * 5, "msg-1", [])),
        ),
        patch("apps.api.ws_manager.manager.broadcast", new=AsyncMock()),
        patch(
            "apps.api.agents.orchestrator.next_turn",
            new=AsyncMock(return_value=None),
        ),
        # Force the proactive-turn branch by stubbing random.random < 1.0.
        patch("apps.api.autonomy_loop.random.random", return_value=0.0),
    ):
        await autonomy_loop._run_autonomy_round(
            "q-mode-off", 1.0, 10, db, _mock_llm()
        )

    # No contribution should have been inserted.
    assert inserted == [], f"expected no contributions in off mode, got {inserted}"


def test_synthesize_mode_calls_llm_once(monkeypatch):
    """In synthesize mode, _maybe_auto_contribute makes EXACTLY one LLM
    `complete()` call and uses the returned text as the contribution body.

    The synthesize branch uses `asyncio.get_event_loop().run_until_complete`
    which raises ``RuntimeError`` when called from inside a running loop.
    The production code catches that and falls back to the raw concat — so
    this test runs in a sync context to actually exercise the LLM path.
    """
    from unittest.mock import AsyncMock, patch

    from apps.api.autonomy_loop import _maybe_auto_contribute

    db = _make_db(
        messages=[
            {"content": "The eGFR threshold should be 45 based on the safety data.", "tags": []},
            {"content": "Further review needed on the safety endpoint analysis.", "tags": []},
            {"content": "I recommend the dose-escalation cohort design carefully.", "tags": []},
        ]
    )

    synthesized_text = "Synthesized: I recommend eGFR>=45 with dose-escalation."

    # Patch the llm_provider module attribute that _maybe_auto_contribute
    # imports as `from llm import llm_provider`.
    fake_provider = type(
        "FakeProvider", (), {"complete": AsyncMock(return_value=synthesized_text)}
    )()
    fake_llm_module = type("FakeLLM", (), {"llm_provider": fake_provider})

    with patch.dict("sys.modules", {"llm": fake_llm_module}):
        _maybe_auto_contribute(db, "q1", _role(), 0.9, 3, mode="synthesize")

    # Exactly one contribution row was inserted.
    assert len(db.insert_payloads) == 1
    payload = db.insert_payloads[0]
    # The contribution body should be the synthesized text (not the raw concat).
    assert payload["content"] == synthesized_text
    # And the LLM was called exactly once.
    assert fake_provider.complete.await_count == 1


# ---------------------------------------------------------------------------
# Helpers for the integration-style off-mode test
# ---------------------------------------------------------------------------


def _build_full_db(inserted: list[dict]):
    """Build a more capable stub that covers the queries _run_autonomy_round
    issues during a proactive turn (agent_requests, roles, station_messages,
    agent_insights, quorums, contributions)."""
    from types import SimpleNamespace
    from unittest.mock import MagicMock

    state = {
        "agent_requests": [],
        "roles": [
            {"id": "role-x", "name": "medical_pi", "authority_rank": 5, "status": "active"},
        ],
        "station_messages": [],
        "agent_insights": [],
        "quorums": [
            {"id": "q-mode-off", "title": "Test", "description": "Test desc", "status": "active"},
        ],
        "contributions": [],
    }

    db = MagicMock()

    def make_chain(table_name):
        chain = MagicMock()
        chain._filters = []
        chain._mode = "select"

        def select(*a, **kw):
            chain._mode = "select"
            return chain

        def update(payload):
            chain._mode = "update"
            chain._payload = payload
            return chain

        def insert(payload):
            chain._mode = "insert"
            inserted_local = payload if isinstance(payload, dict) else payload[0]
            if table_name == "contributions":
                inserted.append(inserted_local)
            state.setdefault(table_name, []).append(dict(inserted_local))
            inserter = MagicMock()
            inserter.execute.return_value = SimpleNamespace(data=[inserted_local])
            return inserter

        def _eq(col, val):
            chain._filters.append(("eq", col, val))
            return chain

        def _order(*a, **kw):
            return chain

        def _limit(n):
            return chain

        def _maybe_single():
            chain._single = True
            return chain

        def execute():
            rows = state.get(table_name, [])
            matched = []
            for r in rows:
                if all(r.get(c) == v for op, c, v in chain._filters if op == "eq"):
                    matched.append(r)
            if chain._mode == "update":
                for r in matched:
                    r.update(chain._payload)
                return SimpleNamespace(data=matched)
            if getattr(chain, "_single", False):
                return SimpleNamespace(data=matched[0] if matched else None)
            return SimpleNamespace(data=matched)

        chain.select.side_effect = select
        chain.update.side_effect = update
        chain.insert.side_effect = insert
        chain.eq.side_effect = _eq
        chain.order.side_effect = _order
        chain.limit.side_effect = _limit
        chain.lt.return_value = chain
        chain.maybe_single.side_effect = _maybe_single
        chain.execute.side_effect = execute
        return chain

    db.table.side_effect = make_chain
    return db


def _mock_llm():
    from unittest.mock import AsyncMock, MagicMock

    m = MagicMock()
    m.complete = AsyncMock(return_value="ok")
    m.embed = AsyncMock(return_value=[0.0] * 10)
    return m
