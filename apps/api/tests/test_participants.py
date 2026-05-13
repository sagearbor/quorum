"""Tests for the participants endpoints (10.4).

Covers:
- POST /sessions/participant   201 → {participant_id, display_name}
- Auto-assigned display_name: "Visitor 1", "Visitor 2", ... per station_label.
- POST /sessions/heartbeat     204 on success, 404 on unknown participant.

Mocks Supabase at the route layer (mirrors test_agent_endpoints.py).
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers — minimal fake Supabase that captures inserts so the test can read
# back what was written and emulate the "count existing rows" behaviour of
# the visitor-number auto-assignment.
# ---------------------------------------------------------------------------

def _make_state_supabase() -> MagicMock:
    """Stateful fake DB: tracks rows per table; supports .eq() filtering."""

    state: dict[str, list[dict[str, Any]]] = {
        "quorums": [{"id": "quorum-1", "status": "active"}],
        "roles": [{"id": "role-1", "quorum_id": "quorum-1"}],
        "participants": [],
        "contributions": [],
        "events": [],
        "artifacts": [],
        "station_messages": [],
        "agent_insights": [],
        "agent_documents": [],
        "agent_requests": [],
    }

    def _table(name: str):
        chain = MagicMock()
        chain._filters = []  # list of (col, val) tuples
        chain._is_single = False
        chain._pending_insert: dict[str, Any] | None = None
        chain._pending_update: dict[str, Any] | None = None

        def _select(*_args, **_kw):
            return chain

        def _eq(col, val):
            chain._filters.append((col, val))
            return chain

        def _maybe_single():
            chain._is_single = True
            return chain

        def _single():
            chain._is_single = True
            return chain

        def _order(*_args, **_kw):
            return chain

        def _limit(*_args, **_kw):
            return chain

        def _insert(row):
            chain._pending_insert = row
            return chain

        def _update(patch):
            chain._pending_update = patch
            return chain

        def _execute():
            rows = state.setdefault(name, [])

            if chain._pending_insert is not None:
                rows.append(dict(chain._pending_insert))
                result = MagicMock()
                result.data = [chain._pending_insert]
                chain._pending_insert = None
                return result

            if chain._pending_update is not None:
                updated = []
                for r in rows:
                    if all(r.get(c) == v for c, v in chain._filters):
                        r.update(chain._pending_update)
                        updated.append(r)
                result = MagicMock()
                result.data = updated
                chain._pending_update = None
                return result

            # SELECT — apply .eq() filters
            filtered = [
                r for r in rows
                if all(r.get(c) == v for c, v in chain._filters)
            ]
            result = MagicMock()
            if chain._is_single:
                result.data = filtered[0] if filtered else None
            else:
                result.data = filtered
            return result

        chain.select.side_effect = _select
        chain.eq.side_effect = _eq
        chain.maybe_single.side_effect = _maybe_single
        chain.single.side_effect = _single
        chain.order.side_effect = _order
        chain.limit.side_effect = _limit
        chain.insert.side_effect = _insert
        chain.update.side_effect = _update
        chain.execute.side_effect = _execute
        return chain

    db = MagicMock()
    db.table.side_effect = _table
    db._state = state  # expose for assertions
    return db


@pytest.fixture()
def client():
    """TestClient backed by a stateful fake Supabase."""
    from fastapi.testclient import TestClient

    fake_db = _make_state_supabase()

    with (
        patch("apps.api.routes.get_supabase", return_value=fake_db),
        patch("database.get_supabase", return_value=fake_db),
        patch("apps.api.routes.llm_provider", MagicMock(complete=AsyncMock(return_value="ok"))),
        patch("apps.api.routes.process_agent_turn", new=AsyncMock(
            return_value=("reply", str(uuid.uuid4()), [])
        )),
        patch("apps.api.routes.process_a2a_request", new=AsyncMock(return_value="resp")),
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
    ):
        import coordination.factory as coord_factory
        coord_factory._backend = None

        import importlib
        import apps.api.main as main_mod
        importlib.reload(main_mod)
        yield TestClient(main_mod.app, raise_server_exceptions=False), fake_db

        coord_factory._backend = None


# ---------------------------------------------------------------------------
# POST /sessions/participant
# ---------------------------------------------------------------------------

class TestCreateParticipant:
    def test_returns_201_with_id_and_display_name(self, client):
        c, db = client
        resp = c.post(
            "/sessions/participant",
            json={
                "quorum_id": "quorum-1",
                "role_id": "role-1",
                "station_label": "station-1",
                "device_kind": "phone",
            },
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert "participant_id" in body
        # Valid UUID string
        uuid.UUID(body["participant_id"])
        assert body["display_name"] == "Visitor 1"
        # Row was persisted
        assert len(db._state["participants"]) == 1
        assert db._state["participants"][0]["device_kind"] == "phone"

    def test_visitor_number_increments_per_station(self, client):
        c, _ = client
        payload = {
            "quorum_id": "quorum-1",
            "station_label": "station-1",
            "device_kind": "phone",
        }
        first = c.post("/sessions/participant", json=payload).json()
        second = c.post("/sessions/participant", json=payload).json()
        assert first["display_name"] == "Visitor 1"
        assert second["display_name"] == "Visitor 2"
        assert first["participant_id"] != second["participant_id"]

    def test_visitor_numbers_are_per_station(self, client):
        c, _ = client
        a1 = c.post(
            "/sessions/participant",
            json={
                "quorum_id": "quorum-1",
                "station_label": "station-1",
                "device_kind": "phone",
            },
        ).json()
        b1 = c.post(
            "/sessions/participant",
            json={
                "quorum_id": "quorum-1",
                "station_label": "station-2",
                "device_kind": "phone",
            },
        ).json()
        # Each station starts its own visitor counter.
        assert a1["display_name"] == "Visitor 1"
        assert b1["display_name"] == "Visitor 1"

    def test_unknown_quorum_returns_404(self, client):
        c, _ = client
        resp = c.post(
            "/sessions/participant",
            json={
                "quorum_id": "does-not-exist",
                "station_label": "station-1",
                "device_kind": "phone",
            },
        )
        assert resp.status_code == 404

    def test_invalid_device_kind_returns_422(self, client):
        c, _ = client
        resp = c.post(
            "/sessions/participant",
            json={
                "quorum_id": "quorum-1",
                "station_label": "station-1",
                "device_kind": "smartwatch",
            },
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# POST /sessions/heartbeat
# ---------------------------------------------------------------------------

class TestHeartbeat:
    def test_heartbeat_updates_last_heartbeat_at(self, client):
        c, db = client
        # First create a participant so we have a valid id.
        created = c.post(
            "/sessions/participant",
            json={
                "quorum_id": "quorum-1",
                "station_label": "station-1",
                "device_kind": "phone",
            },
        ).json()
        pid = created["participant_id"]
        before = db._state["participants"][0].get("last_heartbeat_at")

        resp = c.post("/sessions/heartbeat", json={"participant_id": pid})
        assert resp.status_code == 204
        after = db._state["participants"][0].get("last_heartbeat_at")
        # The update wrote a fresh ISO timestamp.
        assert after is not None
        assert after != before

    def test_unknown_participant_returns_404(self, client):
        c, _ = client
        resp = c.post(
            "/sessions/heartbeat",
            json={"participant_id": str(uuid.uuid4())},
        )
        assert resp.status_code == 404
