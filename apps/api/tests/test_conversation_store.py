"""Tests for ``apps/api/conversation_store.py`` — checklist item 9.2.

These tests use a deliberately tiny in-memory fake of the Supabase / SQLite
client interface (``.table().select().eq().is_().maybe_single().execute()``,
``.insert().execute()``, ``.update().eq().execute()``).  No Postgres / SQLite
required — the fake just records writes and answers reads from an in-memory
dict keyed by (quorum_id, role_id, participant_id).

Coverage:
- ``load_history`` returns ``[]`` when no row exists (not None, not error).
- ``save_history`` upserts a fresh row when none exists.
- ``save_history`` appends to an existing row's ``messages`` list (preserves prior turns).
- A NULL participant_id bucket coexists with non-NULL participant rows.
- Failures in the DB layer never raise to the caller.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from conversation_store import load_history, save_history


# ---------------------------------------------------------------------------
# In-memory fake DB
# ---------------------------------------------------------------------------


class _FakeConversationsDB:
    """Tiny fake of the Supabase python client scoped to the ``conversations`` table.

    The on-disk state is a dict keyed by (quorum_id, role_id, participant_id)
    mapping to a row dict.  Reads honour the most recently chained .eq() /
    .is_() filters; writes mutate the store in place.  Everything else
    (insert, update, select+execute) is a thin builder that records intent
    and resolves at .execute().
    """

    def __init__(self):
        # key: (quorum_id, role_id, participant_id_or_None) -> row dict
        self.rows: dict[tuple, dict] = {}
        self.insert_calls: list[dict] = []
        self.update_calls: list[dict] = []

    def table(self, name):
        assert name == "conversations", f"only conversations supported, got {name}"
        return _Query(self)


class _Query:
    def __init__(self, db: _FakeConversationsDB):
        self.db = db
        # Pending filters (used by both select and update flows)
        self.filters: dict = {}
        self._select_cols: str | None = None
        self._pending_insert: dict | None = None
        self._pending_update: dict | None = None
        self._maybe_single = False

    # --- select chain ---
    def select(self, cols="*"):
        self._select_cols = cols
        return self

    def eq(self, key, value):
        self.filters[key] = value
        return self

    def is_(self, key, value):
        # supabase-py uses .is_(col, 'null') for NULL comparisons.
        assert value == "null"
        self.filters[key] = None
        return self

    def maybe_single(self):
        self._maybe_single = True
        return self

    # --- mutation chain ---
    def insert(self, row):
        self._pending_insert = row
        return self

    def update(self, payload):
        self._pending_update = payload
        return self

    # --- execute ---
    def execute(self):
        if self._pending_insert is not None:
            row = self._pending_insert
            key = (row["quorum_id"], row["role_id"], row.get("participant_id"))
            self.db.rows[key] = dict(row)
            self.db.insert_calls.append(dict(row))
            return MagicMock(data=dict(row))

        if self._pending_update is not None:
            # Update is keyed by .eq('id', ...) — find the row with that id.
            target_id = self.filters.get("id")
            assert target_id, "update without id filter not modelled"
            for key, row in self.db.rows.items():
                if row.get("id") == target_id:
                    row.update(self._pending_update)
                    self.db.update_calls.append({"id": target_id, **self._pending_update})
                    return MagicMock(data=dict(row))
            return MagicMock(data=None)

        # SELECT path
        key = (
            self.filters.get("quorum_id"),
            self.filters.get("role_id"),
            self.filters.get("participant_id"),
        )
        row = self.db.rows.get(key)
        if self._maybe_single:
            return MagicMock(data=(dict(row) if row else None))
        return MagicMock(data=([dict(row)] if row else []))


# ---------------------------------------------------------------------------
# load_history
# ---------------------------------------------------------------------------


def test_load_returns_empty_on_no_row():
    db = _FakeConversationsDB()
    result = load_history(db, "q1", "r1", participant_id=None)
    assert result == [], "load_history must return [] when no row exists"


def test_load_returns_empty_on_db_failure():
    """A DB exception must be swallowed and produce an empty history."""

    class _ExplodingDB:
        def table(self, name):
            raise RuntimeError("postgres on fire")

    result = load_history(_ExplodingDB(), "q1", "r1", participant_id=None)
    assert result == []


# ---------------------------------------------------------------------------
# save_history
# ---------------------------------------------------------------------------


def test_save_upserts_new_row():
    """When no row exists for the triple, save_history INSERTs one."""
    db = _FakeConversationsDB()
    # Use opaque message-like objects — the stub serialiser in the API conftest
    # accepts dicts directly so we pass dict-shaped sentinels.
    new_messages = [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}]

    save_history(db, "q1", "r1", new_messages=new_messages, participant_id=None)

    key = ("q1", "r1", None)
    assert key in db.rows, "row should have been inserted"
    row = db.rows[key]
    assert row["quorum_id"] == "q1"
    assert row["role_id"] == "r1"
    assert row["participant_id"] is None
    # The stub serialiser passes dicts through verbatim — so the stored
    # ``messages`` should be the same list shape we handed in.
    assert isinstance(row["messages"], list)
    assert len(row["messages"]) == 2
    assert len(db.insert_calls) == 1
    assert len(db.update_calls) == 0


def test_save_appends_to_existing_row():
    """A second save_history call must APPEND to the prior row's messages."""
    db = _FakeConversationsDB()
    first = [{"role": "user", "content": "Turn 1 user"}, {"role": "assistant", "content": "Turn 1 reply"}]
    second = [{"role": "user", "content": "Turn 2 user"}, {"role": "assistant", "content": "Turn 2 reply"}]

    save_history(db, "q1", "r1", new_messages=first, participant_id=None)
    save_history(db, "q1", "r1", new_messages=second, participant_id=None)

    key = ("q1", "r1", None)
    row = db.rows[key]
    # Combined length = 2 + 2 = 4 messages persisted in order.
    assert len(row["messages"]) == 4
    # Order preserved: first-turn user comes before second-turn user.
    contents = [m.get("content") for m in row["messages"]]
    assert contents == [
        "Turn 1 user",
        "Turn 1 reply",
        "Turn 2 user",
        "Turn 2 reply",
    ]
    # Path used UPDATE on the second call, not INSERT.
    assert len(db.insert_calls) == 1
    assert len(db.update_calls) == 1


def test_null_participant_separate_from_non_null():
    """Two saves under the SAME (quorum, role) but DIFFERENT participant_ids
    must produce TWO independent rows.  This is the bucketing contract.
    """
    db = _FakeConversationsDB()
    null_messages = [{"role": "user", "content": "Autonomous"}]
    human_messages = [{"role": "user", "content": "Human-driven"}]

    save_history(db, "q1", "r1", new_messages=null_messages, participant_id=None)
    save_history(db, "q1", "r1", new_messages=human_messages, participant_id="p-human")

    assert ("q1", "r1", None) in db.rows
    assert ("q1", "r1", "p-human") in db.rows
    assert db.rows[("q1", "r1", None)]["messages"][0]["content"] == "Autonomous"
    assert db.rows[("q1", "r1", "p-human")]["messages"][0]["content"] == "Human-driven"


def test_save_with_empty_delta_is_noop():
    """Empty new_messages must NOT trigger a redundant write."""
    db = _FakeConversationsDB()
    save_history(db, "q1", "r1", new_messages=[], participant_id=None)
    assert db.rows == {}
    assert db.insert_calls == []
    assert db.update_calls == []


def test_save_failure_does_not_raise():
    """DB-layer exceptions in save_history must be swallowed.

    A failed save is a missed-context cost on the NEXT turn — strictly
    better than failing the turn the user just successfully completed.
    """

    class _ExplodingDB:
        def table(self, name):
            raise RuntimeError("postgres on fire")

    # Must not raise.
    save_history(
        _ExplodingDB(),
        "q1",
        "r1",
        new_messages=[{"role": "user", "content": "Hi"}],
        participant_id=None,
    )


def test_load_after_save_round_trips():
    """A save followed by a load should return the persisted history."""
    db = _FakeConversationsDB()
    messages = [{"role": "user", "content": "Round trip"}]
    save_history(db, "q1", "r1", new_messages=messages, participant_id=None)

    loaded = load_history(db, "q1", "r1", participant_id=None)
    assert isinstance(loaded, list)
    # In production the round trip yields ModelMessage instances; in the test
    # conftest stub the deserialiser is identity, so we get the dict back.
    # Either way the list must be non-empty.
    assert len(loaded) >= 1
