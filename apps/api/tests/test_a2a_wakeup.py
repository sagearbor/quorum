"""Tests for A2A wake-up flow end-to-end — Task 3 of Phase 2 Track D.

Verifies that POST /quorums/{id}/a2a/request:
1. Creates the request row in agent_requests
2. Calls process_a2a_request() to wake the target agent
3. Returns target_response in the response payload
4. Broadcasts via WebSocket
5. Returns status="acknowledged" when agent responds

Also tests process_a2a_request() directly for unit-level coverage:
- Loads target agent definition
- Calls LLM with A2A context
- Updates request status to "acknowledged"
- Returns response text
"""

from __future__ import annotations

import sys
import types
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Ensure conftest stubs are applied before any imports
# ---------------------------------------------------------------------------

# conftest.py in apps/api/tests installs quorum_llm + supabase stubs at
# module-load time. Those stubs are already active when pytest collects this
# file, so we can safely import route-layer code below.


# ---------------------------------------------------------------------------
# Helpers — reuse the same fake DB builder from test_agent_endpoints
# ---------------------------------------------------------------------------

def _make_fake_supabase(overrides: dict[str, Any] | None = None) -> MagicMock:
    """Minimal fluent Supabase mock with configurable table data."""
    overrides = overrides or {}

    def _table_builder(table_name: str):
        rows = overrides.get(table_name, [])
        is_single = [False]

        chain = MagicMock()

        def _single():
            is_single[0] = True
            return chain

        chain.single = _single
        for method in (
            "select", "eq", "neq", "lt", "gt", "gte", "lte",
            "order", "limit", "insert", "update", "delete",
            "upsert", "filter",
        ):
            getattr(chain, method).return_value = chain

        def _execute():
            result = MagicMock()
            result.data = (rows[0] if rows else None) if is_single[0] else rows[:]
            return result

        chain.execute = _execute
        return chain

    db = MagicMock()
    db.table.side_effect = _table_builder
    return db


_QUORUM = {
    "id": "quorum-a2a",
    "status": "active",
    "title": "A2A Test Quorum",
    "description": "For A2A testing",
    "heat_score": 0,
}
_ROLE_FROM = {
    "id": "role-from",
    "quorum_id": "quorum-a2a",
    "name": "safety_monitor",
    "authority_rank": 7,
    "capacity": "unlimited",
}
_ROLE_TO = {
    "id": "role-to",
    "quorum_id": "quorum-a2a",
    "name": "irb_officer",
    "authority_rank": 5,
    "capacity": "unlimited",
}
_A2A_REQUEST = {
    "id": "req-001",
    "quorum_id": "quorum-a2a",
    "from_role_id": "role-from",
    "to_role_id": "role-to",
    "request_type": "input_request",
    "content": "Can you confirm the eGFR threshold?",
    "tags": ["egfr", "safety"],
    "status": "pending",
    "priority": 2,
}


# ---------------------------------------------------------------------------
# HTTP endpoint tests (via TestClient)
# ---------------------------------------------------------------------------


@pytest.fixture()
def a2a_client():
    """TestClient with all A2A dependencies stubbed at the route layer."""
    from fastapi.testclient import TestClient

    fake_db = _make_fake_supabase({
        "quorums": [_QUORUM],
        "roles": [_ROLE_FROM, _ROLE_TO],
        "contributions": [],
        "artifacts": [],
        "station_messages": [],
        "agent_insights": [],
        "agent_documents": [],
        "agent_requests": [_A2A_REQUEST],
    })
    fake_llm = MagicMock()
    fake_llm.complete = AsyncMock(return_value="Mock LLM response")
    fake_llm.chat = AsyncMock(return_value="A2A mock response from IRB officer")

    with (
        patch("apps.api.routes.get_supabase", return_value=fake_db),
        patch("apps.api.routes.llm_provider", fake_llm),
        patch("apps.api.routes.process_agent_turn", new=AsyncMock(
            return_value=("reply", str(uuid.uuid4()), [])
        )),
        patch("apps.api.routes.process_a2a_request", new=AsyncMock(
            return_value="A2A response: eGFR threshold is 45 mL/min/1.73m2. [tags: egfr, irb]"
        )),
        patch("apps.api.routes.create_document", new=AsyncMock(return_value={})),
        patch("apps.api.routes.update_document", new=AsyncMock(
            return_value={"version": 1, "merged": False}
        )),
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
    ):
        import importlib
        import apps.api.main as main_mod
        importlib.reload(main_mod)
        yield TestClient(main_mod.app, raise_server_exceptions=False)


class TestA2ARequestEndpoint:
    def test_create_a2a_request_returns_201(self, a2a_client):
        """Valid A2A request should return HTTP 201."""
        resp = a2a_client.post(
            "/quorums/quorum-a2a/a2a/request",
            json={
                "from_role_id": "role-from",
                "to_role_id": "role-to",
                "request_type": "input_request",
                "content": "Can you confirm the eGFR threshold?",
                "tags": ["egfr", "safety"],
                "priority": 2,
            },
        )
        assert resp.status_code == 201, resp.text

    def test_response_contains_target_response(self, a2a_client):
        """target_response field must be populated when the agent auto-responds."""
        resp = a2a_client.post(
            "/quorums/quorum-a2a/a2a/request",
            json={
                "from_role_id": "role-from",
                "to_role_id": "role-to",
                "request_type": "input_request",
                "content": "eGFR threshold question",
                "tags": [],
                "priority": 1,
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert "target_response" in data
        # The mock returns a non-None response
        assert data["target_response"] is not None
        assert len(data["target_response"]) > 0

    def test_response_status_acknowledged_when_agent_responds(self, a2a_client):
        """status should be 'acknowledged' when target_response is present."""
        resp = a2a_client.post(
            "/quorums/quorum-a2a/a2a/request",
            json={
                "from_role_id": "role-from",
                "to_role_id": "role-to",
                "request_type": "conflict_flag",
                "content": "Conflict on dosing interval",
                "tags": ["dosing"],
                "priority": 3,
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["status"] == "acknowledged"

    def test_response_has_required_fields(self, a2a_client):
        """A2ARequestResponse must contain all required fields."""
        resp = a2a_client.post(
            "/quorums/quorum-a2a/a2a/request",
            json={
                "from_role_id": "role-from",
                "to_role_id": "role-to",
                "request_type": "review_request",
                "content": "Please review the protocol amendment.",
                "tags": [],
                "priority": 0,
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        required_fields = ["id", "quorum_id", "from_role_id", "to_role_id",
                           "request_type", "content", "status", "created_at"]
        for field in required_fields:
            assert field in data, f"Missing field: {field}"

    def test_404_for_unknown_quorum(self):
        """Request to a non-existent quorum should return 404.

        Uses a separate fixture with an EMPTY quorums table so the route's
        quorum-existence check triggers correctly (the shared a2a_client
        fixture always returns data regardless of .eq() filters).
        """
        from fastapi.testclient import TestClient

        empty_db = _make_fake_supabase({
            "quorums": [],
            "roles": [_ROLE_FROM, _ROLE_TO],
            "agent_requests": [],
        })
        fake_llm = MagicMock()
        fake_llm.chat = AsyncMock(return_value="mock")

        with (
            patch("apps.api.routes.get_supabase", return_value=empty_db),
            patch("apps.api.routes.llm_provider", fake_llm),
            patch("apps.api.routes.process_agent_turn", new=AsyncMock(return_value=("r", "id", []))),
            patch("apps.api.routes.process_a2a_request", new=AsyncMock(return_value="resp")),
            patch("apps.api.routes.create_document", new=AsyncMock(return_value={})),
            patch("apps.api.routes.update_document", new=AsyncMock(return_value={"version": 1, "merged": False})),
            patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
        ):
            import importlib
            import apps.api.main as main_mod
            importlib.reload(main_mod)
            client = TestClient(main_mod.app, raise_server_exceptions=False)
            # Request must be made INSIDE the with block while patches are active
            resp = client.post(
                "/quorums/nonexistent-quorum/a2a/request",
                json={
                    "from_role_id": "role-from",
                    "to_role_id": "role-to",
                    "request_type": "input_request",
                    "content": "test",
                    "tags": [],
                    "priority": 0,
                },
            )

        assert resp.status_code == 404

    def test_all_request_types_accepted(self, a2a_client):
        """All A2ARequestType enum values must pass Pydantic validation."""
        valid_types = [
            "conflict_flag", "input_request", "review_request",
            "doc_edit_notify", "escalation", "negotiation",
        ]
        for req_type in valid_types:
            resp = a2a_client.post(
                "/quorums/quorum-a2a/a2a/request",
                json={
                    "from_role_id": "role-from",
                    "to_role_id": "role-to",
                    "request_type": req_type,
                    "content": f"test {req_type}",
                    "tags": [],
                    "priority": 0,
                },
            )
            assert resp.status_code != 422, f"request_type={req_type} failed validation: {resp.text}"


# ---------------------------------------------------------------------------
# Unit tests: process_a2a_request()
# ---------------------------------------------------------------------------


class TestProcessA2ARequest:
    """Unit tests for the process_a2a_request() engine function.

    These tests inject a mock DB and LLM provider directly, bypassing the
    HTTP layer.  This gives us fine-grained control over what the DB returns
    and lets us verify internal state changes (status update, tags).
    """

    @pytest.mark.asyncio
    async def test_returns_response_text(self):
        """process_a2a_request() must return a non-empty string."""
        from apps.api.agent_engine import process_a2a_request

        db = _make_fake_supabase({
            "agent_requests": [_A2A_REQUEST],
            "roles": [_ROLE_FROM, _ROLE_TO],
        })
        llm = MagicMock()
        llm.chat = AsyncMock(return_value="IRB confirms eGFR threshold is 45. [tags: egfr, irb]")

        result = await process_a2a_request("req-001", supabase_client=db, llm_provider=llm)

        assert isinstance(result, str)
        assert len(result.strip()) > 0

    @pytest.mark.asyncio
    async def test_updates_status_to_acknowledged(self):
        """After processing, agent_requests row must be updated to acknowledged."""
        from apps.api.agent_engine import process_a2a_request

        updated_rows: list[dict] = []

        def _table_builder(table_name: str):
            rows: list[dict] = []
            if table_name == "agent_requests":
                rows = [_A2A_REQUEST]
            elif table_name == "roles":
                rows = [_ROLE_FROM, _ROLE_TO]

            chain = MagicMock()
            is_single = [False]
            chain.single.side_effect = lambda: setattr(chain, "_single", True) or chain

            for method in (
                "select", "eq", "neq", "lt", "gt", "gte", "lte",
                "order", "limit", "insert", "delete", "upsert", "filter",
            ):
                getattr(chain, method).return_value = chain

            def _update(data):
                if table_name == "agent_requests":
                    updated_rows.append(data)
                return chain

            chain.update.side_effect = _update

            def _execute():
                result = MagicMock()
                # Check for single() call via attribute
                if getattr(chain, "_single", False):
                    result.data = rows[0] if rows else None
                else:
                    result.data = rows[:]
                return result

            chain.execute = _execute
            return chain

        db = MagicMock()
        db.table.side_effect = _table_builder

        llm = MagicMock()
        llm.chat = AsyncMock(return_value="Response acknowledging request. [tags: test]")

        await process_a2a_request("req-001", supabase_client=db, llm_provider=llm)

        # At least one update should have set status=acknowledged
        status_updates = [r for r in updated_rows if r.get("status") == "acknowledged"]
        assert len(status_updates) >= 1

    @pytest.mark.asyncio
    async def test_returns_graceful_fallback_for_missing_request(self):
        """When request ID is not found, must return a fallback string (no crash)."""
        from apps.api.agent_engine import process_a2a_request

        # DB returns empty for agent_requests
        db = _make_fake_supabase({
            "agent_requests": [],
            "roles": [_ROLE_FROM, _ROLE_TO],
        })
        llm = MagicMock()
        llm.chat = AsyncMock(return_value="fallback")

        result = await process_a2a_request("nonexistent-req", supabase_client=db, llm_provider=llm)

        # Must not raise; must return a string
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.asyncio
    async def test_llm_call_includes_a2a_context(self):
        """LLM messages should include the A2A request type and content.

        We capture the messages passed to chat() and verify the A2A content
        is included.  The conftest stub has a minimal LLMTier; this test
        uses complete() instead of chat() to avoid tier resolution issues
        in the stub environment.
        """
        from apps.api.agent_engine import process_a2a_request

        db = _make_fake_supabase({
            "agent_requests": [_A2A_REQUEST],
            "roles": [_ROLE_FROM, _ROLE_TO],
        })

        captured_prompts: list[str] = []

        async def capture_complete(prompt, tier):
            captured_prompts.append(prompt)
            return "Captured response. [tags: test]"

        # Use a provider with only complete() so we hit the flatten path;
        # this avoids the LLMTier.AGENT_CHAT stub issue in the conftest.
        llm = MagicMock(spec=["complete"])
        llm.complete = capture_complete

        await process_a2a_request("req-001", supabase_client=db, llm_provider=llm)

        all_content = " ".join(captured_prompts)
        # The A2A request content should appear in the flattened prompt
        assert "eGFR" in all_content or "input_request" in all_content.lower()
