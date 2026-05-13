"""Tests for checklist item 11.9 — agent_configs.temperature / max_tokens
are now respected at LLM call time.

The bug: the architect can set ``agent_configs.temperature = 0.8`` per role
but the runtime call site (``_call_llm`` in ``agent_engine.py``) didn't
read it, so every agent used the tier default.  This file verifies the
plumbing now flows end-to-end.

Coverage:
  - ``agent_configs.temperature=0.8`` → provider receives ``temperature=0.8``
  - No agent_def → provider receives no overrides (None defaults)
  - Reasoning model + temperature override → WARNING logged, override dropped
  - ``max_tokens`` override flows through the same way
  - Out-of-range temperature is clamped to [0, 1] with a warning
  - Null ``max_tokens`` in DB is treated as "use default" (None)
  - ``_safe_call_with_overrides`` falls back gracefully when a legacy mock
    chat() rejects the new kwargs
"""

from __future__ import annotations

import logging
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_engine import (
    _resolve_call_settings,
    _safe_call_with_overrides,
    process_agent_turn,
)
# Use the apps/api/agents package — there's a separate top-level ``agents``
# package at the repo root (the static YAML personas for the legacy adapter)
# which has a different ``AgentDefinition`` shape and would shadow this one
# under pytest's path order.  Import via the qualified path to be explicit.
from apps.api.agents import AgentDefinition


# ---------------------------------------------------------------------------
# Fake DB — minimal but enough for process_agent_turn to walk through.
# ---------------------------------------------------------------------------


class _TableSpy:
    def __init__(self, store, name):
        self._store = store
        self._name = name
        self._inserts = store.setdefault(name, [])
        self._filters: dict = {}
        self._single = False

    def insert(self, row):
        self._inserts.append(row)
        return self

    def select(self, *_a, **_kw):
        return self

    def eq(self, key, value):
        self._filters[key] = value
        return self

    def neq(self, *_a, **_kw):
        return self

    def is_(self, *_a, **_kw):
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def update(self, *_a, **_kw):
        return self

    def maybe_single(self):
        self._single = True
        return self

    def single(self):
        self._single = True
        return self

    def execute(self):
        if self._name == "roles":
            return MagicMock(data={"name": "Researcher", "authority_rank": 5})
        if self._name == "quorums":
            return MagicMock(
                data={"title": "Test Quorum", "description": "", "autonomy_level": 0.0}
            )
        return MagicMock(data=[])


class _FakeSupabase:
    def __init__(self):
        self.inserts: dict[str, list[dict]] = {}

    def table(self, name):
        return _TableSpy(self.inserts, name)


# ---------------------------------------------------------------------------
# Unit tests for _resolve_call_settings — pure function, no async.
# ---------------------------------------------------------------------------


def test_resolve_returns_none_when_agent_def_missing():
    """No agent_def → no overrides → tier defaults take effect downstream."""
    temp, max_t = _resolve_call_settings(None)
    assert temp is None
    assert max_t is None


def test_resolve_passes_through_temperature_and_max_tokens():
    """Architect-authored overrides flow through unchanged."""
    defn = AgentDefinition(
        name="Researcher",
        instructions="...",
        temperature=0.8,
        max_tokens=2048,
        model="gpt-4o-mini",
    )
    temp, max_t = _resolve_call_settings(defn)
    assert temp == pytest.approx(0.8)
    assert max_t == 2048


def test_resolve_clamps_out_of_range_temperature(caplog):
    """Out-of-range temperature is clamped to [0, 1] with a WARNING."""
    defn = AgentDefinition(
        name="Hot",
        instructions="...",
        temperature=1.7,  # over the CHECK constraint upper bound
        max_tokens=1024,
        model="gpt-4o-mini",
    )
    with caplog.at_level(logging.WARNING, logger="agent_engine"):
        temp, _ = _resolve_call_settings(defn)
    assert temp == pytest.approx(1.0)
    assert any("clamped" in rec.message for rec in caplog.records)


def test_resolve_drops_temperature_for_reasoning_models(caplog):
    """Reasoning models (gpt-5/o1/o3/o4) reject temperature → we drop with WARNING."""
    defn = AgentDefinition(
        name="Reasoner",
        instructions="...",
        temperature=0.6,
        max_tokens=2048,
        model="gpt-5-nano",
    )
    with caplog.at_level(logging.WARNING, logger="agent_engine"):
        temp, max_t = _resolve_call_settings(defn)
    assert temp is None, "temperature must be dropped for reasoning models"
    assert max_t == 2048, "max_tokens should still pass through for reasoning models"
    assert any("reasoning model" in rec.message for rec in caplog.records)


def test_resolve_drops_temperature_for_o3_model(caplog):
    """o3 series is also reasoning — same drop-with-warning behaviour."""
    defn = AgentDefinition(
        name="O3", instructions="...", temperature=0.5, model="o3-mini"
    )
    with caplog.at_level(logging.WARNING, logger="agent_engine"):
        temp, _ = _resolve_call_settings(defn)
    assert temp is None


def test_resolve_null_max_tokens_treated_as_default():
    """max_tokens=None / 0 → leave it as None so the tier default takes over."""
    # The AgentDefinition dataclass coerces None to its default (1024), so to
    # simulate "null in DB" we drop the attribute via a stub.
    class _Bare:
        name = "Bare"
        instructions = "..."
        domain_tags: list[str] = []
        model = "gpt-4o-mini"
        temperature = 0.4
        max_tokens = None  # simulating null in agent_configs row

    temp, max_t = _resolve_call_settings(_Bare())
    assert temp == pytest.approx(0.4)
    assert max_t is None


def test_resolve_rejects_garbage_temperature():
    """A non-numeric temperature string in the DB should be treated as 'unset'."""
    class _Junk:
        name = "Junk"
        instructions = "..."
        domain_tags: list[str] = []
        model = "gpt-4o-mini"
        temperature = "high"  # bogus value somehow in the DB
        max_tokens = 1024

    temp, max_t = _resolve_call_settings(_Junk())
    assert temp is None
    assert max_t == 1024


# ---------------------------------------------------------------------------
# Integration: process_agent_turn threads overrides through to the provider.
# ---------------------------------------------------------------------------


def _make_llm_capturing(call_kwargs: dict):
    """Build an LLM mock whose chat_with_history captures all kwargs."""
    llm = MagicMock()

    async def _fake(messages, tier, message_history=None, **kw):
        call_kwargs["messages"] = messages
        call_kwargs["tier"] = tier
        call_kwargs["message_history"] = message_history
        call_kwargs.update(kw)
        result = MagicMock()
        result.text = "Substantial reply for the researcher with enough content for an insight"
        result.new_messages = []
        return result

    llm.chat_with_history = AsyncMock(side_effect=_fake)
    return llm


@pytest.mark.asyncio
async def test_process_agent_turn_threads_temperature_override(monkeypatch):
    """agent_configs.temperature=0.8 → provider receives temperature=0.8."""
    db = _FakeSupabase()
    captured: dict = {}
    llm = _make_llm_capturing(captured)

    # Force a specific agent_def with temperature=0.8 + non-reasoning model.
    # ``domain_tags`` intentionally empty so the engine's insights-relevance
    # short-circuit fires and we avoid the conftest stub's positional-only
    # ``find_relevant_agents`` signature (irrelevant to this test).
    custom = AgentDefinition(
        name="Researcher",
        instructions="You are the researcher.",
        domain_tags=[],
        temperature=0.8,
        max_tokens=1536,
        model="gpt-4o-mini",
    )
    monkeypatch.setattr("agent_engine._load_agent_definition", lambda *a, **kw: custom)

    await process_agent_turn(
        quorum_id="q1",
        role_id="r1",
        station_id="s1",
        user_message="Hello",
        supabase_client=db,
        llm_provider=llm,
    )

    assert captured.get("temperature") == pytest.approx(0.8), (
        f"expected temperature=0.8 in provider call kwargs, got {captured!r}"
    )
    assert captured.get("max_tokens") == 1536, (
        f"expected max_tokens=1536 in provider call kwargs, got {captured!r}"
    )


@pytest.mark.asyncio
async def test_process_agent_turn_no_overrides_when_agent_def_missing(monkeypatch):
    """No agent_configs row → provider receives no temperature/max_tokens kwargs."""
    db = _FakeSupabase()
    captured: dict = {}
    llm = _make_llm_capturing(captured)

    monkeypatch.setattr("agent_engine._load_agent_definition", lambda *a, **kw: None)

    await process_agent_turn(
        quorum_id="q1",
        role_id="r1",
        station_id="s1",
        user_message="Hello",
        supabase_client=db,
        llm_provider=llm,
    )

    # No agent_def → _resolve returns (None, None) → no kwargs added → these
    # keys MUST NOT appear in the provider call so tier defaults take over.
    assert "temperature" not in captured, (
        f"unexpected temperature override leaked through: {captured!r}"
    )
    assert "max_tokens" not in captured


@pytest.mark.asyncio
async def test_process_agent_turn_drops_temperature_for_reasoning_model(
    monkeypatch, caplog
):
    """Reasoning model + temperature override → WARNING logged, no override passed."""
    db = _FakeSupabase()
    captured: dict = {}
    llm = _make_llm_capturing(captured)

    custom = AgentDefinition(
        name="Reasoner",
        instructions="You are the reasoner.",
        domain_tags=[],  # see comment in non-reasoning test
        temperature=0.6,
        max_tokens=2048,
        model="gpt-5-nano",  # reasoning model
    )
    monkeypatch.setattr("agent_engine._load_agent_definition", lambda *a, **kw: custom)

    # The gpt-5 fast path uses ``respond()`` first.  We want this test to
    # exercise the chat() path so we explicitly delete ``respond`` from the
    # mock (the engine's ``hasattr`` check skips that branch).
    del llm.respond

    with caplog.at_level(logging.WARNING, logger="agent_engine"):
        await process_agent_turn(
            quorum_id="q1",
            role_id="r1",
            station_id="s1",
            user_message="Hello",
            supabase_client=db,
            llm_provider=llm,
        )

    # Temperature was dropped → key absent from the call kwargs.
    assert "temperature" not in captured, (
        "temperature must NOT be sent to a reasoning model — Pydantic AI also "
        "drops it but we should not let it leak past resolve()"
    )
    # max_tokens still flows through.
    assert captured.get("max_tokens") == 2048
    # And the architect sees a warning that their setting had no effect.
    assert any("reasoning model" in rec.message for rec in caplog.records)


@pytest.mark.asyncio
async def test_process_agent_turn_max_tokens_only(monkeypatch):
    """Only max_tokens is overridden (temperature stays at default) → only
    max_tokens shows up in the provider kwargs."""
    db = _FakeSupabase()
    captured: dict = {}
    llm = _make_llm_capturing(captured)

    # AgentDefinition's default temperature is 0.4 — same as the tier default,
    # so the resolver still emits it.  To prove "only max_tokens flows" we
    # need a stub that has temperature=None.
    class _OnlyMaxTokens:
        name = "OnlyMax"
        instructions = "..."
        domain_tags: list[str] = []
        model = "gpt-4o-mini"
        temperature = None
        max_tokens = 4096

    monkeypatch.setattr(
        "agent_engine._load_agent_definition", lambda *a, **kw: _OnlyMaxTokens()
    )

    await process_agent_turn(
        quorum_id="q1",
        role_id="r1",
        station_id="s1",
        user_message="Hello",
        supabase_client=db,
        llm_provider=llm,
    )

    assert "temperature" not in captured
    assert captured.get("max_tokens") == 4096


# ---------------------------------------------------------------------------
# Backward compat: legacy chat() signatures still work.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_safe_call_with_overrides_falls_back_on_typeerror():
    """A legacy chat() that doesn't accept temperature/max_tokens still gets called."""
    calls: list[dict] = []

    async def legacy_chat(messages, tier, message_history=None):
        # Pretends it's a pre-11.9 mock that only knows about message_history.
        calls.append({"messages": messages, "tier": tier, "message_history": message_history})
        return "legacy reply"

    text = await _safe_call_with_overrides(
        legacy_chat,
        [{"role": "user", "content": "hi"}],
        "AGENT_CHAT",
        call_overrides={"temperature": 0.7, "max_tokens": 256},
        message_history=None,
    )
    assert text == "legacy reply"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_safe_call_with_overrides_falls_back_to_two_arg_call():
    """An ancient chat() with only (messages, tier) still works."""
    calls: list[dict] = []

    async def ancient_chat(messages, tier):
        calls.append({"messages": messages, "tier": tier})
        return "ancient reply"

    text = await _safe_call_with_overrides(
        ancient_chat,
        [{"role": "user", "content": "hi"}],
        "AGENT_CHAT",
        call_overrides={"temperature": 0.5},
        message_history=None,
    )
    assert text == "ancient reply"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_safe_call_with_overrides_prefers_full_kwargs():
    """When chat() supports all kwargs, no fallback is triggered."""
    calls: list[dict] = []

    async def modern_chat(messages, tier, message_history=None, temperature=None, max_tokens=None):
        calls.append({
            "messages": messages,
            "tier": tier,
            "message_history": message_history,
            "temperature": temperature,
            "max_tokens": max_tokens,
        })
        return "modern reply"

    text = await _safe_call_with_overrides(
        modern_chat,
        [{"role": "user", "content": "hi"}],
        "AGENT_CHAT",
        call_overrides={"temperature": 0.65, "max_tokens": 999},
        message_history=[{"role": "user", "content": "earlier"}],
    )
    assert text == "modern reply"
    assert calls[0]["temperature"] == pytest.approx(0.65)
    assert calls[0]["max_tokens"] == 999
    assert calls[0]["message_history"] == [{"role": "user", "content": "earlier"}]
