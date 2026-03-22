"""Tests for blocked_by dependency chain feature.

Tests:
- Role with blocked_by gets status=blocked
- resolve_dependencies unblocks correctly
- Chain A blocks B blocks C resolves in sequence
- WebSocket event fires on unblock
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

os.environ["QUORUM_TEST_MODE"] = "true"
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "llm"))
sys.path.insert(0, str(ROOT / "apps"))


# ---------------------------------------------------------------------------
# Re-use the in-memory Supabase mock from test_routes_integration
# ---------------------------------------------------------------------------

class MockQueryResult:
    def __init__(self, data):
        self.data = data


class MockTableQuery:
    def __init__(self, table, data):
        self._table = table
        self._data = data
        self._filters = []
        self._is_single = False
        self._order_col = None

    def eq(self, col, val):
        self._filters.append((col, val))
        return self

    def single(self):
        self._is_single = True
        return self

    def order(self, col):
        self._order_col = col
        return self

    def select(self, cols):
        return self

    def execute(self):
        result = self._data
        for col, val in self._filters:
            result = [r for r in result if r.get(col) == val]
        if self._order_col:
            result = sorted(result, key=lambda r: r.get(self._order_col, ""))
        if self._is_single:
            return MockQueryResult(result[0] if result else None)
        return MockQueryResult(result)


class MockInsertQuery:
    def __init__(self, table, row):
        self._table = table
        self._row = row

    def execute(self):
        if "created_at" not in self._row:
            self._row["created_at"] = datetime.now(timezone.utc).isoformat()
        self._table._rows.append(self._row)
        return MockQueryResult([self._row])


class MockUpdateQuery:
    def __init__(self, table, updates):
        self._table = table
        self._updates = updates
        self._filters = []

    def eq(self, col, val):
        self._filters.append((col, val))
        return self

    def execute(self):
        updated = []
        for row in self._table._rows:
            match = all(row.get(c) == v for c, v in self._filters)
            if match:
                row.update(self._updates)
                updated.append(row)
        return MockQueryResult(updated)


class MockTable:
    def __init__(self, name):
        self.name = name
        self._rows = []

    def select(self, cols="*"):
        return MockTableQuery(self, self._rows)

    def insert(self, row):
        return MockInsertQuery(self, row)

    def update(self, updates):
        return MockUpdateQuery(self, updates)


class MockSupabase:
    def __init__(self):
        self._tables = {}

    def table(self, name):
        if name not in self._tables:
            self._tables[name] = MockTable(name)
        return self._tables[name]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_db(monkeypatch):
    db = MockSupabase()
    import api.database as db_mod
    import api.routes as routes_mod
    monkeypatch.setattr(db_mod, "_client", db)
    monkeypatch.setattr(db_mod, "get_supabase", lambda: db)
    monkeypatch.setattr(routes_mod, "get_supabase", lambda: db)
    return db


@pytest.fixture
def mock_llm(monkeypatch):
    from quorum_llm.providers.mock import MockLLMProvider
    provider = MockLLMProvider()
    import api.llm as llm_mod
    monkeypatch.setattr(llm_mod, "_llm_provider", provider)
    import api.routes as routes_mod
    monkeypatch.setattr(routes_mod, "llm_provider", provider)
    return provider


@pytest.fixture
def seeded_db_with_deps(mock_db):
    """DB with event, quorum, and three roles: A (active), B (blocked by A), C (blocked by B)."""
    event_id = "evt-dep-001"
    quorum_id = "qrm-dep-001"

    mock_db.table("events")._rows.append({
        "id": event_id,
        "name": "Dep Test Event",
        "slug": "dep-test",
        "access_code": "test123",
        "max_active_quorums": 5,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    mock_db.table("quorums")._rows.append({
        "id": quorum_id,
        "event_id": event_id,
        "title": "Dependency Test",
        "description": "Testing blocked_by chains",
        "status": "open",
        "heat_score": 0,
        "carousel_mode": "multi-view",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    roles = [
        {
            "id": "role-a",
            "quorum_id": quorum_id,
            "name": "Role A",
            "capacity": "1",
            "authority_rank": 1,
            "prompt_template": [],
            "fallback_chain": [],
            "blocked_by": [],
            "status": "active",
        },
        {
            "id": "role-b",
            "quorum_id": quorum_id,
            "name": "Role B",
            "capacity": "1",
            "authority_rank": 2,
            "prompt_template": [],
            "fallback_chain": [],
            "blocked_by": ["role-a"],
            "status": "blocked",
        },
        {
            "id": "role-c",
            "quorum_id": quorum_id,
            "name": "Role C",
            "capacity": "1",
            "authority_rank": 3,
            "prompt_template": [],
            "fallback_chain": [],
            "blocked_by": ["role-b"],
            "status": "blocked",
        },
    ]
    for r in roles:
        mock_db.table("roles")._rows.append(r)

    return mock_db, event_id, quorum_id


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestBlockedByStatus:
    def test_role_with_blocked_by_gets_blocked_status(self, seeded_db_with_deps):
        """A role with a non-empty blocked_by list should have status='blocked'."""
        db, _, quorum_id = seeded_db_with_deps
        roles = db.table("roles").select("*").eq("quorum_id", quorum_id).execute()

        role_a = next(r for r in roles.data if r["id"] == "role-a")
        role_b = next(r for r in roles.data if r["id"] == "role-b")
        role_c = next(r for r in roles.data if r["id"] == "role-c")

        assert role_a["status"] == "active"
        assert role_b["status"] == "blocked"
        assert role_c["status"] == "blocked"

    def test_role_without_blocked_by_is_active(self, seeded_db_with_deps):
        """A role with empty blocked_by should be active."""
        db, _, quorum_id = seeded_db_with_deps
        role_a = next(
            r for r in db.table("roles").select("*").eq("quorum_id", quorum_id).execute().data
            if r["id"] == "role-a"
        )
        assert role_a["status"] == "active"
        assert role_a["blocked_by"] == []


class TestResolveDependencies:
    @pytest.mark.asyncio
    async def test_unblocks_when_dependency_satisfied(self, seeded_db_with_deps, mock_llm):
        """Contributing to Role A should unblock Role B."""
        from api.routes import contribute
        from api.models import ContributeRequest

        db, _, quorum_id = seeded_db_with_deps

        body = ContributeRequest(
            role_id="role-a",
            user_token="user-1",
            content="Role A contribution",
        )
        await contribute(quorum_id, body)

        role_b = next(
            r for r in db.table("roles").select("*").eq("quorum_id", quorum_id).execute().data
            if r["id"] == "role-b"
        )
        assert role_b["status"] == "active"

    @pytest.mark.asyncio
    async def test_does_not_unblock_when_partial_deps(self, mock_db, mock_llm):
        """A role blocked by two roles should stay blocked until both contribute."""
        event_id = "evt-multi"
        quorum_id = "qrm-multi"

        mock_db.table("events")._rows.append({
            "id": event_id, "name": "Multi", "slug": "multi",
            "access_code": "x", "max_active_quorums": 5,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        mock_db.table("quorums")._rows.append({
            "id": quorum_id, "event_id": event_id, "title": "Multi Dep",
            "description": "", "status": "open", "heat_score": 0,
            "carousel_mode": "multi-view",
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

        mock_db.table("roles")._rows.extend([
            {"id": "r1", "quorum_id": quorum_id, "name": "R1", "capacity": "1",
             "authority_rank": 1, "prompt_template": [], "fallback_chain": [],
             "blocked_by": [], "status": "active"},
            {"id": "r2", "quorum_id": quorum_id, "name": "R2", "capacity": "1",
             "authority_rank": 1, "prompt_template": [], "fallback_chain": [],
             "blocked_by": [], "status": "active"},
            {"id": "r3", "quorum_id": quorum_id, "name": "R3", "capacity": "1",
             "authority_rank": 1, "prompt_template": [], "fallback_chain": [],
             "blocked_by": ["r1", "r2"], "status": "blocked"},
        ])

        from api.routes import contribute
        from api.models import ContributeRequest

        # Only r1 contributes — r3 should stay blocked
        await contribute(quorum_id, ContributeRequest(
            role_id="r1", user_token="u1", content="R1 content",
        ))

        r3 = next(r for r in mock_db.table("roles")._rows if r["id"] == "r3")
        assert r3["status"] == "blocked"

        # Now r2 contributes — r3 should unblock
        await contribute(quorum_id, ContributeRequest(
            role_id="r2", user_token="u2", content="R2 content",
        ))

        r3 = next(r for r in mock_db.table("roles")._rows if r["id"] == "r3")
        assert r3["status"] == "active"


class TestChainResolution:
    @pytest.mark.asyncio
    async def test_chain_a_blocks_b_blocks_c(self, seeded_db_with_deps, mock_llm):
        """A -> B -> C chain: contributing to A unblocks B, then contributing to B unblocks C."""
        from api.routes import contribute
        from api.models import ContributeRequest

        db, _, quorum_id = seeded_db_with_deps

        # Initially: A=active, B=blocked, C=blocked
        # Contribute to A
        await contribute(quorum_id, ContributeRequest(
            role_id="role-a", user_token="u1", content="A content",
        ))

        roles = {r["id"]: r for r in db.table("roles").select("*").eq("quorum_id", quorum_id).execute().data}
        assert roles["role-a"]["status"] == "active"
        assert roles["role-b"]["status"] == "active"  # Unblocked!
        assert roles["role-c"]["status"] == "blocked"  # Still blocked by B

        # Contribute to B
        await contribute(quorum_id, ContributeRequest(
            role_id="role-b", user_token="u2", content="B content",
        ))

        roles = {r["id"]: r for r in db.table("roles").select("*").eq("quorum_id", quorum_id).execute().data}
        assert roles["role-c"]["status"] == "active"  # Now unblocked!


class TestWebSocketUnblockEvent:
    @pytest.mark.asyncio
    async def test_ws_role_unblocked_event_fires(self, seeded_db_with_deps, mock_llm):
        """When a role is unblocked, a WebSocket 'role_unblocked' event should be broadcast."""
        from api.routes import contribute
        from api.models import ContributeRequest

        db, _, quorum_id = seeded_db_with_deps

        broadcast_calls = []
        original_broadcast = None

        import api.routes as routes_mod
        original_broadcast = routes_mod.manager.broadcast

        async def capture_broadcast(qid, msg):
            broadcast_calls.append(msg)

        routes_mod.manager.broadcast = capture_broadcast

        try:
            await contribute(quorum_id, ContributeRequest(
                role_id="role-a", user_token="u1", content="A content",
            ))
        finally:
            routes_mod.manager.broadcast = original_broadcast

        # Find the role_unblocked message
        unblock_msgs = [m for m in broadcast_calls if m.get("type") == "role_unblocked"]
        assert len(unblock_msgs) == 1
        assert unblock_msgs[0]["role_id"] == "role-b"
        assert unblock_msgs[0]["role_name"] == "Role B"


class TestRoleStatusEndpoint:
    @pytest.mark.asyncio
    async def test_get_role_status(self, seeded_db_with_deps, mock_llm):
        """GET /quorums/{id}/role-status returns correct status info."""
        from api.routes import get_role_status

        _, _, quorum_id = seeded_db_with_deps

        result = await get_role_status(quorum_id)
        assert len(result) == 3

        status_map = {r["role_id"]: r for r in result}
        assert status_map["role-a"]["status"] == "active"
        assert status_map["role-a"]["blocked_by_names"] == []
        assert status_map["role-b"]["status"] == "blocked"
        assert status_map["role-b"]["blocked_by_names"] == ["Role A"]
        assert status_map["role-c"]["status"] == "blocked"
        assert status_map["role-c"]["blocked_by_names"] == ["Role B"]
