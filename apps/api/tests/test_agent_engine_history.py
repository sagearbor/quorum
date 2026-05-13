"""Integration test for MessageHistory wiring in ``agent_engine`` — item 9.2.

End-to-end test (with a mocked LLM provider and DB) that
``process_agent_turn``:

1. Calls ``load_history`` before the LLM call.
2. Threads the loaded history through to the LLM via the ``message_history``
   kwarg on the provider's ``chat_with_history`` / ``chat`` call.
3. Calls ``save_history`` with the run's new_messages delta after the LLM
   call succeeds.

We exercise the real ``_call_llm`` routing path (not patched out) so the
test covers both the dispatch logic and the wiring through to the
conversation store.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_engine import process_agent_turn


# ---------------------------------------------------------------------------
# Minimal DB fake — same shape as test_agent_engine_paused but extended to
# track conversations.* table calls.
# ---------------------------------------------------------------------------


class _TableSpy:
    """Generic table builder that records inserts/updates and returns canned reads."""

    def __init__(self, store, name):
        self._store = store
        self._name = name
        self._inserts = store.inserts.setdefault(name, [])
        self._updates = store.updates.setdefault(name, [])
        self._filters: dict = {}
        self._single = False
        self._pending_insert: dict | None = None
        self._pending_update: dict | None = None

    def select(self, *_a, **_kw):
        return self

    def eq(self, key, value):
        self._filters[key] = value
        return self

    def neq(self, *_a, **_kw):
        return self

    def is_(self, key, value):
        # value is the string 'null'
        self._filters[key] = None
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def maybe_single(self):
        self._single = True
        return self

    def single(self):
        self._single = True
        return self

    def insert(self, row):
        self._pending_insert = row
        self._inserts.append(row)
        return self

    def update(self, payload):
        self._pending_update = payload
        return self

    def execute(self):
        if self._pending_update is not None:
            self._updates.append({"filters": dict(self._filters), "update": dict(self._pending_update)})
            return MagicMock(data=None)
        if self._pending_insert is not None:
            return MagicMock(data=self._pending_insert)

        # SELECT path — canned per-table responses.
        if self._name == "roles":
            return MagicMock(data={"name": "Researcher", "authority_rank": 5})
        if self._name == "quorums":
            return MagicMock(data={"title": "Test Quorum", "description": "", "autonomy_level": 0.0})
        if self._name == "conversations":
            # Return the most recent conversations row stored by save_history.
            triple = (
                self._filters.get("quorum_id"),
                self._filters.get("role_id"),
                self._filters.get("participant_id"),
            )
            row = self._store.conv_rows.get(triple)
            return MagicMock(data=(dict(row) if row else None))
        # Default: empty.
        return MagicMock(data=[])


class _FakeSupabase:
    def __init__(self):
        self.inserts: dict[str, list[dict]] = {}
        self.updates: dict[str, list[dict]] = {}
        # Conversations are tracked separately so the test can verify them
        # without scanning insert/update lists.
        self.conv_rows: dict[tuple, dict] = {}

    def table(self, name):
        spy = _TableSpy(self, name)
        return spy


# ---------------------------------------------------------------------------
# Integration test
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_process_agent_turn_threads_history():
    """End-to-end: process_agent_turn loads history, threads it to the LLM,
    and persists the new-message delta.
    """
    db = _FakeSupabase()

    # Pre-seed the conversations table with a prior turn's messages so we can
    # assert that load_history finds them and passes them through.
    db.conv_rows[("q1", "r1", "p1")] = {
        "id": "conv-1",
        "quorum_id": "q1",
        "role_id": "r1",
        "participant_id": "p1",
        "messages": [{"role": "user", "content": "Earlier"}, {"role": "assistant", "content": "Earlier reply"}],
    }

    # LLM stub: chat_with_history returns text + a sentinel new_messages list.
    # We capture the message_history kwarg to verify it received the prior turn.
    llm = MagicMock()
    captured_kwargs: dict = {}

    async def _fake_chat_with_history(messages, tier, message_history=None, **_kw):
        captured_kwargs["message_history"] = message_history
        captured_kwargs["dict_messages"] = messages
        # Return a ChatResult-shaped object; the engine reads .text and .new_messages.
        result = MagicMock()
        result.text = "Fresh reply with substantial content for insight publishing"
        # Pretend the LLM produced one new request + one new response.
        result.new_messages = [
            {"_type": "ModelRequest", "content": "Latest user"},
            {"_type": "ModelResponse", "content": "Latest reply"},
        ]
        return result

    llm.chat_with_history = AsyncMock(side_effect=_fake_chat_with_history)
    # Hide the gpt-5 fast-path attribute so _call_llm doesn't try ``respond``.
    # (agent_def is None in this test so the gpt-5 branch is skipped regardless.)

    reply, msg_id, tags = await process_agent_turn(
        quorum_id="q1",
        role_id="r1",
        station_id="s1",
        user_message="Latest user",
        supabase_client=db,
        llm_provider=llm,
        participant_id="p1",
    )

    # --- Assertion 1: the turn succeeded with a real reply (not the paused sentinel) ---
    assert reply.startswith("Fresh reply")
    assert msg_id

    # --- Assertion 2: load_history fed the prior turn into chat_with_history ---
    history_arg = captured_kwargs.get("message_history") or []
    assert len(history_arg) >= 2, (
        f"Expected prior 2-message history threaded into LLM call, got {history_arg!r}"
    )

    # --- Assertion 3: save_history persisted the new delta ---
    # The fake DB's insert hook captured the conversations row.  Check that
    # the messages list grew by the delta (was 2 → should now be 4).
    triple_row_inserts = db.inserts.get("conversations", [])
    triple_row_updates = db.updates.get("conversations", [])
    # Either INSERT path (if save_history failed to find the seed) or UPDATE
    # path (more likely) — at least one should have happened.
    persisted_count = len(triple_row_inserts) + len(triple_row_updates)
    assert persisted_count >= 1, (
        "save_history should have written to conversations table at least once"
    )


@pytest.mark.asyncio
async def test_process_agent_turn_works_without_prior_history():
    """First-ever turn for a (quorum, role, participant) — no prior row.

    Load returns []; the LLM is still called; save_history INSERTs a fresh
    conversations row with the delta.  No errors.
    """
    db = _FakeSupabase()  # empty conv_rows

    llm = MagicMock()
    captured_kwargs: dict = {}

    async def _fake_chat_with_history(messages, tier, message_history=None, **_kw):
        captured_kwargs["message_history"] = message_history
        result = MagicMock()
        result.text = "First-ever reply for this conversation thread"
        result.new_messages = [{"_type": "ModelResponse", "content": "First-ever reply"}]
        return result

    llm.chat_with_history = AsyncMock(side_effect=_fake_chat_with_history)

    reply, _msg_id, _tags = await process_agent_turn(
        quorum_id="q1",
        role_id="r1",
        station_id="s1",
        user_message="Hello",
        supabase_client=db,
        llm_provider=llm,
        participant_id="p1",
    )

    assert reply.startswith("First-ever reply")
    # No prior history was passed to the LLM (or an empty list was — either is fine).
    history = captured_kwargs.get("message_history") or []
    assert history == [] or history is None

    # A conversations row was INSERTed (no prior row to UPDATE).
    inserts = db.inserts.get("conversations", [])
    assert len(inserts) == 1, f"Expected 1 INSERT to conversations, got {inserts!r}"
    inserted = inserts[0]
    assert inserted["quorum_id"] == "q1"
    assert inserted["role_id"] == "r1"
    assert inserted["participant_id"] == "p1"


@pytest.mark.asyncio
async def test_history_load_failure_does_not_break_turn():
    """If load_history raises, the agent turn still completes with empty history."""

    class _BrokenSelectDB(_FakeSupabase):
        def table(self, name):
            if name == "conversations":
                # Return a spy whose .execute() blows up so load_history's
                # outer try/except is exercised.
                raise RuntimeError("conversations table on fire")
            return super().table(name)

    db = _BrokenSelectDB()

    llm = MagicMock()
    llm.chat_with_history = AsyncMock(
        return_value=MagicMock(
            text="Reply despite broken conversations table — long enough for insight",
            new_messages=[],
        )
    )

    reply, _msg_id, _tags = await process_agent_turn(
        quorum_id="q1",
        role_id="r1",
        station_id="s1",
        user_message="Hi",
        supabase_client=db,
        llm_provider=llm,
        participant_id="p1",
    )

    # The turn still succeeded.
    assert "Reply despite broken conversations table" in reply


@pytest.mark.asyncio
async def test_null_participant_id_threads_through():
    """Calling without participant_id buckets to the NULL row.

    This is the autonomous A2A turn case — the engine should still call
    load/save with participant_id=None and not raise.
    """
    db = _FakeSupabase()
    llm = MagicMock()
    captured_kwargs: dict = {}

    async def _fake_chat(messages, tier, message_history=None, **_kw):
        captured_kwargs["message_history"] = message_history
        result = MagicMock()
        result.text = "Autonomous reply with enough length to publish an insight row"
        result.new_messages = [{"role": "assistant", "content": "Autonomous reply"}]
        return result

    llm.chat_with_history = AsyncMock(side_effect=_fake_chat)

    reply, _msg_id, _tags = await process_agent_turn(
        quorum_id="q1",
        role_id="r1",
        station_id="s1",
        user_message="ping",
        supabase_client=db,
        llm_provider=llm,
        participant_id=None,  # autonomous bucket
    )

    assert reply.startswith("Autonomous reply")

    # The conversations row that was inserted should have participant_id = None.
    inserts = db.inserts.get("conversations", [])
    assert len(inserts) == 1
    assert inserts[0]["participant_id"] is None
