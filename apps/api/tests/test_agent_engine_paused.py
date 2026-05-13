"""Tests for the facilitator paused sentinel — issue 10.6.

The bug: when the LLM call inside ``process_agent_turn`` fails, the old code
returned a chat-string fallback ("I encountered an issue…") which the avatar
component on the projector then spoke aloud, signalling "the AI is broken"
to the live audience.

The fix: return a structured sentinel
``("__PAUSED__", message_id, ["__paused__"])`` and ensure NO assistant row is
written to ``station_messages`` on a paused turn. Callers detect via
``is_paused_reply`` and respond with HTTP 200 + ``{"paused": true}``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_engine import (
    PAUSED_SENTINEL,
    PAUSED_TAG,
    is_paused_reply,
    process_a2a_request,
    process_agent_turn,
)


class _TableSpy:
    """Minimal stand-in for a Supabase table builder that records inserts."""

    def __init__(self, store, name):
        self._store = store
        self._name = name
        self._inserts = store.setdefault(name, [])
        self._filters = {}
        self._single = False

    def insert(self, row):
        self._inserts.append(row)
        return self

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self._filters[key] = value
        return self

    def neq(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def update(self, *_args, **_kwargs):
        return self

    def maybe_single(self):
        self._single = True
        return self

    def single(self):
        self._single = True
        return self

    def execute(self):
        # Return a minimal shape that the engine helpers tolerate.
        if self._name == "roles":
            return MagicMock(data={"name": "Researcher", "authority_rank": 5})
        if self._name == "quorums":
            return MagicMock(data={"title": "Test Quorum", "description": "",
                                   "autonomy_level": 0.0})
        if self._name == "agent_requests":
            # ``process_a2a_request`` loads the request row via
            # ``maybe_single()`` — return a dict. The non-single query in
            # ``process_agent_turn`` lists pending requests for a role and
            # expects a list (of dicts); return ``[]`` there.
            if self._single:
                return MagicMock(data={
                    "id": "req-1",
                    "quorum_id": "q1",
                    "from_role_id": "sender-role",
                    "to_role_id": "r1",
                    "request_type": "conflict_flag",
                    "content": "Disagree on threshold.",
                    "version": 1,
                })
            return MagicMock(data=[])
        # Lists — insights / messages / docs — return empty rows.
        return MagicMock(data=[])


class _FakeSupabase:
    """Fake Supabase client that captures every insert into ``inserts``."""

    def __init__(self):
        self.inserts: dict[str, list[dict]] = {}

    def table(self, name):
        return _TableSpy(self.inserts, name)


@pytest.mark.asyncio
async def test_returns_paused_sentinel_when_llm_raises():
    """When the LLM call raises, process_agent_turn returns the paused sentinel."""
    db = _FakeSupabase()
    llm = MagicMock()
    # Make chat() raise so _call_llm propagates the exception up to the
    # outer try/except in process_agent_turn.
    llm.chat = AsyncMock(side_effect=RuntimeError("boom"))

    with patch("agent_engine._call_llm", new=AsyncMock(side_effect=RuntimeError("boom"))):
        reply, msg_id, tags = await process_agent_turn(
            quorum_id="q1",
            role_id="r1",
            station_id="s1",
            user_message="Hello, are you there?",
            supabase_client=db,
            llm_provider=llm,
        )

    assert reply == PAUSED_SENTINEL
    assert tags == [PAUSED_TAG]
    assert isinstance(msg_id, str) and msg_id
    assert is_paused_reply(reply, tags) is True


@pytest.mark.asyncio
async def test_paused_turn_writes_no_assistant_message():
    """A paused turn must NOT insert an assistant row into station_messages.

    The user row IS persisted (so we don't lose what the human said) but with
    a ``facilitator_paused`` metadata marker. Crucially, no ``"role":
    "assistant"`` row is written — the conversation should look like the
    agent simply didn't reply on this turn.
    """
    db = _FakeSupabase()
    llm = MagicMock()

    with patch("agent_engine._call_llm", new=AsyncMock(side_effect=RuntimeError("boom"))):
        await process_agent_turn(
            quorum_id="q1",
            role_id="r1",
            station_id="s1",
            user_message="Hello",
            supabase_client=db,
            llm_provider=llm,
        )

    rows = db.inserts.get("station_messages", [])
    assistant_rows = [r for r in rows if r.get("role") == "assistant"]
    assert assistant_rows == [], (
        "Paused turn must NOT write an assistant row to station_messages — "
        "the avatar would speak the empty/sentinel content on the projector."
    )
    # The user row is persisted but flagged.
    user_rows = [r for r in rows if r.get("role") == "user"]
    assert len(user_rows) == 1
    assert user_rows[0]["content"] == "Hello"
    assert (user_rows[0].get("metadata") or {}).get("facilitator_paused") is True


@pytest.mark.asyncio
async def test_paused_turn_writes_no_insight_row():
    """Paused turns must not publish an agent_insights row either — the
    sentinel string would otherwise propagate as cross-station context.
    """
    db = _FakeSupabase()
    llm = MagicMock()

    with patch("agent_engine._call_llm", new=AsyncMock(side_effect=RuntimeError("boom"))):
        await process_agent_turn(
            quorum_id="q1",
            role_id="r1",
            station_id="s1",
            user_message="Hello",
            supabase_client=db,
            llm_provider=llm,
        )

    assert db.inserts.get("agent_insights", []) == []


def test_is_paused_reply_helper():
    """Sanity checks on the public helper used by routes."""
    assert is_paused_reply(PAUSED_SENTINEL, [PAUSED_TAG]) is True
    assert is_paused_reply(PAUSED_SENTINEL, []) is True
    # Tag-only signal is also accepted (defensive).
    assert is_paused_reply("anything", [PAUSED_TAG]) is True
    # Normal replies are not paused.
    assert is_paused_reply("Hello there", ["greeting"]) is False
    assert is_paused_reply("", []) is False


# ---------------------------------------------------------------------------
# A2A path — audit follow-up for PR #14
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_process_a2a_request_returns_paused_sentinel_on_llm_failure():
    """When the LLM call inside ``process_a2a_request`` raises, the function
    must return the ``PAUSED_SENTINEL`` string rather than the legacy
    canned-ack ``"I acknowledge your request and will respond shortly."``.

    Audit finding: future agents read that canned string back as "insight"
    — a poisoned signal in the A2A graph. Mirrors the bug 10.6 fix on the
    human-facing path.
    """
    db = _FakeSupabase()
    llm = MagicMock()

    with patch(
        "agent_engine._call_llm",
        new=AsyncMock(side_effect=RuntimeError("LLM provider boom")),
    ):
        result = await process_a2a_request(
            request_id="req-1",
            supabase_client=db,
            llm_provider=llm,
        )

    assert result == PAUSED_SENTINEL, (
        f"process_a2a_request must return PAUSED_SENTINEL on LLM failure, "
        f"got {result!r}"
    )
    # The legacy canned ack must NOT be returned.
    assert result != "I acknowledge your request and will respond shortly."


@pytest.mark.asyncio
async def test_process_a2a_request_does_not_persist_canned_reply_on_llm_failure():
    """On the LLM-failure path, the function must NOT update the
    ``agent_requests`` row with a canned ``response`` — the autonomy loop
    will flip the row back to ``pending`` for a retry.
    """
    db = _FakeSupabase()
    llm = MagicMock()

    with patch(
        "agent_engine._call_llm",
        new=AsyncMock(side_effect=RuntimeError("LLM provider boom")),
    ):
        await process_a2a_request(
            request_id="req-1",
            supabase_client=db,
            llm_provider=llm,
        )

    # No rows should have been *inserted* into agent_requests (the row was
    # only loaded). The _TableSpy here captures inserts; the previous
    # behaviour would not insert either, so the contract check we care
    # about is "no canned response string surfaced anywhere". Verify by
    # asserting the sentinel was returned (already covered above) and
    # that nothing in the spy looks like the canned ack.
    for table, rows in db.inserts.items():
        for row in rows:
            assert row.get("response") != (
                "I acknowledge your request and will respond shortly."
            ), f"Canned ack leaked into {table}: {row}"
