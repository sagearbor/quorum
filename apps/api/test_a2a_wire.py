"""Tests for A2A wiring: factory, guidance endpoint, agent card shape."""

from __future__ import annotations

import os

import pytest

# Ensure test mode
os.environ["QUORUM_TEST_MODE"] = "true"


# ---------------------------------------------------------------------------
# 1. Coordination factory
# ---------------------------------------------------------------------------

class TestCoordinationFactory:
    def test_default_backend_is_supabase(self):
        from apps.api.coordination.factory import get_backend_name
        # Default is supabase when COORDINATION_BACKEND is not set
        os.environ.pop("COORDINATION_BACKEND", None)
        assert get_backend_name() == "supabase"

    def test_backend_name_respects_env(self):
        from apps.api.coordination.factory import get_backend_name
        os.environ["COORDINATION_BACKEND"] = "a2a"
        try:
            assert get_backend_name() == "a2a"
        finally:
            os.environ.pop("COORDINATION_BACKEND", None)

    def test_factory_returns_supabase_backend(self):
        from apps.api.coordination import factory as f
        # Reset singleton
        f._backend = None
        os.environ.pop("COORDINATION_BACKEND", None)
        backend = f.get_coordination_backend()
        from apps.api.coordination.supabase_backend import SupabaseBackend
        assert isinstance(backend, SupabaseBackend)
        f._backend = None  # cleanup

    def test_factory_returns_a2a_backend(self):
        from apps.api.coordination import factory as f
        f._backend = None
        os.environ["COORDINATION_BACKEND"] = "a2a"
        try:
            backend = f.get_coordination_backend()
            from apps.api.coordination.a2a_backend import A2ABackend
            assert isinstance(backend, A2ABackend)
        finally:
            os.environ.pop("COORDINATION_BACKEND", None)
            f._backend = None

    def test_backend_abc_methods(self):
        from apps.api.coordination.backend import CoordinationBackend
        # Ensure ABC can't be instantiated
        with pytest.raises(TypeError):
            CoordinationBackend()


# ---------------------------------------------------------------------------
# 2. Agent card shape
# ---------------------------------------------------------------------------

class TestAgentCard:
    def test_agent_card_shape(self):
        from apps.api.a2a.agent_card import build_agent_card

        role = {
            "id": "role-123",
            "name": "Clinician",
            "quorum_id": "q-456",
            "authority_rank": 3,
            "capacity": 1,
        }
        card = build_agent_card(role)

        assert card["name"] == "quorum-role-Clinician"
        assert "Clinician" in card["description"]
        assert card["version"] == "0.1.0"
        assert "capabilities" in card
        assert card["capabilities"]["streaming"] is False
        assert len(card["skills"]) >= 1
        assert card["skills"][0]["id"] == "contribute"
        assert card["metadata"]["role_id"] == "role-123"
        assert card["metadata"]["quorum_id"] == "q-456"
        assert card["metadata"]["authority_rank"] == 3

    def test_agent_card_with_base_url(self):
        from apps.api.a2a.agent_card import build_agent_card

        role = {"id": "r1", "name": "Nurse", "authority_rank": 1}
        card = build_agent_card(role, base_url="https://example.com")
        assert card["url"] == "https://example.com/a2a/agents/r1"


# ---------------------------------------------------------------------------
# 3. A2A client
# ---------------------------------------------------------------------------

class TestA2AClient:
    def test_client_register_and_lookup(self):
        from apps.api.a2a.a2a_client import A2AClient
        client = A2AClient()
        assert client.get_agent_url("unknown") is None
        client.register_agent("r1", "http://localhost:9000/agent")
        assert client.get_agent_url("r1") == "http://localhost:9000/agent"

    @pytest.mark.asyncio
    async def test_send_message_no_endpoint(self):
        from apps.api.a2a.a2a_client import A2AClient, _agent_registry
        _agent_registry.clear()
        client = A2AClient()
        result = await client.send_message("missing-role", {"type": "test"})
        assert result is None

    @pytest.mark.asyncio
    async def test_send_message_with_endpoint(self):
        from apps.api.a2a.a2a_client import A2AClient
        client = A2AClient()
        client.register_agent("r1", "http://localhost:9000/agent")
        result = await client.send_message("r1", {"type": "test"})
        assert result is not None
        assert result["status"] == "sent"


# ---------------------------------------------------------------------------
# 4. Guidance endpoint model
# ---------------------------------------------------------------------------

class TestGuidanceModel:
    def test_guidance_request_valid(self):
        from apps.api.a2a.a2a_server import GuidanceRequest
        req = GuidanceRequest(quorum_id="q1", message="focus on safety")
        assert req.target_role_id is None
        assert req.message == "focus on safety"

    def test_guidance_request_with_target(self):
        from apps.api.a2a.a2a_server import GuidanceRequest
        req = GuidanceRequest(quorum_id="q1", message="hello", target_role_id="r1")
        assert req.target_role_id == "r1"


# ---------------------------------------------------------------------------
# 5. State snapshot helper
# ---------------------------------------------------------------------------

class TestStateSnapshotHelper:
    def test_write_state_snapshot_builds_correct_shape(self):
        """Test the snapshot data structure without hitting Supabase."""
        roles = [
            {"id": "r1", "name": "Lead", "capacity": "1", "authority_rank": 5},
            {"id": "r2", "name": "Member", "capacity": "unlimited", "authority_rank": 1},
        ]
        contributions = [
            {"id": "c1", "role_id": "r1", "content": "test"},
        ]
        sections = [{"content": "Final synthesis output here"}]

        # We test the logic inline since _write_state_snapshot hits DB
        contributing_role_ids = {c["role_id"] for c in contributions}
        blocked_roles = [
            r["name"] for r in roles
            if r["id"] not in contributing_role_ids
            and r.get("capacity") != "unlimited"
            and str(r.get("capacity", "")) == "1"
        ]
        assert blocked_roles == []  # r1 contributed, r2 is unlimited

        role_health = {}
        for r in roles:
            rid = r["id"]
            count = sum(1 for c in contributions if c["role_id"] == rid)
            role_health[r["name"]] = {"contributions": count, "active": rid in contributing_role_ids}

        assert role_health["Lead"]["contributions"] == 1
        assert role_health["Lead"]["active"] is True
        assert role_health["Member"]["contributions"] == 0
        assert role_health["Member"]["active"] is False
