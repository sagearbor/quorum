"""Tests for the auto-promote-chat-turn pipeline added for the expo demo.

When ``quorums.auto_promote_chat`` is TRUE (default), ``process_agent_turn``
runs the Tier-2 contribution analyzer on every agent reply.  If the resulting
``sum(|score_deltas|)`` is above the threshold (15), the reply is auto-promoted
into the ``contributions`` table so the chart moves during conversation
without the user having to find the structured form.

Coverage in this file:
  - High-magnitude analyzer output → contributions row inserted
  - Low-magnitude analyzer output → no insert
  - Flag explicitly OFF on the quorums row → no insert (even with high score)
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_engine import process_agent_turn
from apps.api.agents import AgentDefinition


# ---------------------------------------------------------------------------
# Fake DB — tracks every insert so we can assert on contributions rows.
# ---------------------------------------------------------------------------

class _TableSpy:
    def __init__(self, store, name, quorum_row):
        self._store = store
        self._name = name
        self._inserts = store.setdefault(name, [])
        self._updates = store.setdefault(f"{name}__updates", [])
        self._quorum_row = quorum_row
        self._single = False

    def insert(self, row):
        self._inserts.append(row)
        return self

    def select(self, *_a, **_kw):
        return self

    def eq(self, *_a, **_kw):
        return self

    def neq(self, *_a, **_kw):
        return self

    def is_(self, *_a, **_kw):
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def update(self, payload):
        self._updates.append(payload)
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
            return MagicMock(data=self._quorum_row)
        return MagicMock(data=[])


class _FakeSupabase:
    def __init__(self, *, auto_promote_chat=True):
        self.store: dict = {}
        self.quorum_row = {
            "title": "Test Quorum",
            "description": "",
            "autonomy_level": 0.0,
            "auto_promote_chat": auto_promote_chat,
            "llm_metric_deltas": {},
            "llm_metric_rationales": [],
        }

    def table(self, name):
        return _TableSpy(self.store, name, self.quorum_row)

    def contributions_inserted(self) -> list[dict]:
        return list(self.store.get("contributions", []))


def _make_llm():
    """Build an LLM mock that returns a substantial agent reply."""
    llm = MagicMock()

    async def _fake(messages, tier, message_history=None, **kw):
        result = MagicMock()
        result.text = (
            "My position: we should require red-teaming for all clinical AI "
            "tools before they touch a patient.  That has to be a hard gate."
        )
        result.new_messages = []
        return result

    llm.chat_with_history = AsyncMock(side_effect=_fake)
    return llm


def _agent_def() -> AgentDefinition:
    return AgentDefinition(
        name="Researcher",
        instructions="...",
        domain_tags=[],
        temperature=0.5,
        max_tokens=1024,
        model="gpt-4o-mini",
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_high_magnitude_reply_auto_promotes_into_contributions(monkeypatch):
    """sum(|deltas|) ≥ 15 → contributions row inserted with user_token=ai-agent."""
    db = _FakeSupabase(auto_promote_chat=True)
    llm = _make_llm()

    monkeypatch.setattr(
        "agent_engine._load_agent_definition", lambda *a, **kw: _agent_def()
    )

    # Stub analyzer in agent_engine's import scope (it's imported lazily inside
    # _maybe_auto_promote_contribution so we patch the module path it imports).
    async def _high_magnitude_analyzer(
        content, role_name, role_authority_rank, llm_provider
    ):
        analysis = MagicMock()
        analysis.tags = ["red_teaming", "clinical", "gating"]
        # Sum of |deltas| = 12 + 8 = 20, well above the threshold of 15.
        analysis.score_deltas = {"consensus": 12.0, "blockers": -8.0}
        analysis.rationale = "Definite position taken — should require red-teaming."
        return analysis

    import quorum_llm.contribution_analyzer as _ca_mod
    monkeypatch.setattr(_ca_mod, "analyze_contribution", _high_magnitude_analyzer)

    await process_agent_turn(
        quorum_id="q1",
        role_id="r1",
        station_id="s1",
        user_message="What's your position on red-teaming?",
        supabase_client=db,
        llm_provider=llm,
    )

    contributions = db.contributions_inserted()
    assert len(contributions) == 1, (
        f"expected exactly one auto-promoted contribution, got {contributions!r}"
    )
    row = contributions[0]
    assert row["user_token"] == "ai-agent"
    assert row["role_id"] == "r1"
    assert row["quorum_id"] == "q1"
    assert row["tier_processed"] == 1
    assert row["structured_fields"] == {}
    assert row["analysis_tags"] == ["red_teaming", "clinical", "gating"]
    assert row["analysis_deltas"] == {"consensus": 12.0, "blockers": -8.0}
    assert "red-teaming" in row["analysis_rationale"]
    assert "red-teaming" in row["content"]


@pytest.mark.asyncio
async def test_low_magnitude_reply_does_not_promote(monkeypatch):
    """sum(|deltas|) < 15 → no contributions row inserted."""
    db = _FakeSupabase(auto_promote_chat=True)
    llm = _make_llm()

    monkeypatch.setattr(
        "agent_engine._load_agent_definition", lambda *a, **kw: _agent_def()
    )

    async def _low_magnitude_analyzer(
        content, role_name, role_authority_rank, llm_provider
    ):
        analysis = MagicMock()
        analysis.tags = ["chat", "small_talk", "noise"]
        # Sum of |deltas| = 2.0 — below the 15 threshold.
        analysis.score_deltas = {"consensus": 1.0, "completion": 1.0}
        analysis.rationale = "Filler — no real position taken."
        return analysis

    import quorum_llm.contribution_analyzer as _ca_mod
    monkeypatch.setattr(_ca_mod, "analyze_contribution", _low_magnitude_analyzer)

    await process_agent_turn(
        quorum_id="q1",
        role_id="r1",
        station_id="s1",
        user_message="What's up?",
        supabase_client=db,
        llm_provider=llm,
    )

    contributions = db.contributions_inserted()
    assert contributions == [], (
        f"expected no auto-promoted contribution for low-magnitude reply, got {contributions!r}"
    )


@pytest.mark.asyncio
async def test_flag_off_skips_auto_promote_even_for_high_score(monkeypatch):
    """quorums.auto_promote_chat=False → no insert even with high deltas."""
    db = _FakeSupabase(auto_promote_chat=False)
    llm = _make_llm()

    monkeypatch.setattr(
        "agent_engine._load_agent_definition", lambda *a, **kw: _agent_def()
    )

    promoted_called = {"count": 0}

    async def _high_magnitude_analyzer(
        content, role_name, role_authority_rank, llm_provider
    ):
        promoted_called["count"] += 1
        analysis = MagicMock()
        analysis.tags = ["red_teaming", "clinical", "gating"]
        analysis.score_deltas = {"consensus": 15.0, "blockers": -10.0}
        analysis.rationale = "Definite position."
        return analysis

    import quorum_llm.contribution_analyzer as _ca_mod

    monkeypatch.setattr(_ca_mod, "analyze_contribution", _high_magnitude_analyzer)

    await process_agent_turn(
        quorum_id="q1",
        role_id="r1",
        station_id="s1",
        user_message="What's your position?",
        supabase_client=db,
        llm_provider=llm,
    )

    assert promoted_called["count"] == 0, (
        "analyzer should not have been called when auto_promote_chat=False"
    )
    contributions = db.contributions_inserted()
    assert contributions == [], (
        f"flag OFF must skip auto-promote, got {contributions!r}"
    )
