"""End-to-end tests for the A2A 1.0 protocol surface.

Coverage:
1. ``GET .well-known/agent-card.json`` returns a spec-compliant card.
2. ``GET .well-known/agent.json`` alias serves identical content.
3. ``POST /tasks/send`` accepts an A2A SendMessageRequest and returns a
   SendMessageResponse with a COMPLETED Task and the agent's reply.
4. ``POST /message:send`` (v1.0 canonical) returns the same shape.
5. ``A2AClient.send_message`` end-to-end: agent A POSTs a task to agent B
   via the FastAPI test client and reads back the reply.
6. ``lookup_endpoint`` reads from the ``agent_endpoints`` table.

The tests mock the LLM provider and the Supabase client. The FastAPI app
is loaded via ``apps.api.main`` so the real routes (not stubs) handle the
requests — only the I/O dependencies (DB, LLM) are patched.
"""

from __future__ import annotations

import sys
import types
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Test fixtures + fake Supabase
# ---------------------------------------------------------------------------

# Stub `dotenv` and `supabase` (conftest does it, but assert in this file too
# so the test is robust to running in isolation).
sys.modules.setdefault("dotenv", types.SimpleNamespace(load_dotenv=lambda: None))

_QUORUM_ID = "quorum-a2a-proto"
_ROLE_A_ID = "role-aaaaaa"
_ROLE_B_ID = "role-bbbbbb"

_ROLE_A = {
    "id": _ROLE_A_ID,
    "quorum_id": _QUORUM_ID,
    "name": "safety_monitor",
    "authority_rank": 7,
    "capacity": "unlimited",
}
_ROLE_B = {
    "id": _ROLE_B_ID,
    "quorum_id": _QUORUM_ID,
    "name": "irb_officer",
    "authority_rank": 5,
    "capacity": "1",
}
_AGENT_CONFIG_B = {
    "role_id": _ROLE_B_ID,
    "system_prompt": (
        "You are the IRB officer for this clinical trial. Review safety "
        "questions and respond with regulatory references."
    ),
    "domain_tags": ["irb", "regulatory", "safety"],
    "agent_slug": "irb_officer",
}
_AGENT_ENDPOINT_B = {
    "role_id": _ROLE_B_ID,
    "url": "http://testserver/a2a/agents/" + _ROLE_B_ID,
    "capabilities": {"name": "irb_officer", "authority_rank": 5},
}


def _make_fake_supabase(overrides: dict[str, list[dict[str, Any]]] | None = None) -> MagicMock:
    """Minimal fluent Supabase mock with per-table data and .eq() filtering.

    Unlike the simpler mocks in other test files, this one honours .eq()
    filters so the route's role/endpoint lookups behave realistically.
    """
    overrides = overrides or {}

    def _table_builder(table_name: str):
        rows = list(overrides.get(table_name, []))
        # Track filter state across the chained calls.
        state = {"single": False, "filters": []}
        chain = MagicMock()

        def _single():
            state["single"] = True
            return chain

        def _maybe_single():
            state["single"] = True
            return chain

        def _eq(col, val):
            state["filters"].append((col, val))
            return chain

        chain.single = _single
        chain.maybe_single = _maybe_single
        chain.eq.side_effect = _eq

        # The remaining fluent methods just return self.
        for method in (
            "select", "neq", "lt", "gt", "gte", "lte",
            "order", "limit", "insert", "update", "delete",
            "upsert", "filter",
        ):
            getattr(chain, method).return_value = chain

        def _execute():
            filtered = rows
            for col, val in state["filters"]:
                filtered = [r for r in filtered if str(r.get(col)) == str(val)]
            result = MagicMock()
            if state["single"]:
                result.data = filtered[0] if filtered else None
            else:
                result.data = filtered
            return result

        chain.execute = _execute
        return chain

    db = MagicMock()
    db.table.side_effect = _table_builder
    return db


@pytest.fixture()
def a2a_app():
    """Boot the FastAPI app with mocked DB + LLM provider."""
    from fastapi.testclient import TestClient

    fake_db = _make_fake_supabase({
        "quorums": [{"id": _QUORUM_ID, "title": "A2A Proto", "description": "test"}],
        "roles": [_ROLE_A, _ROLE_B],
        "agent_configs": [_AGENT_CONFIG_B],
        "agent_endpoints": [_AGENT_ENDPOINT_B],
        "station_messages": [],
        "agent_insights": [],
        "agent_documents": [],
        "agent_requests": [],
        "contributions": [],
    })
    fake_llm = MagicMock()
    fake_llm.complete = AsyncMock(
        return_value="IRB confirms: eGFR 45 is the cut-off. [tags: irb, egfr]"
    )
    fake_llm.chat = AsyncMock(
        return_value="IRB confirms: eGFR 45 is the cut-off. [tags: irb, egfr]"
    )

    # The A2A server route loads agent_engine.process_agent_turn lazily inside
    # the handler, so we patch the bare module path (which conftest.py keeps
    # aliased to apps.api.agent_engine).
    canned_reply = "IRB confirms: eGFR 45 is the cut-off. [tags: irb, egfr]"
    fake_process_agent_turn = AsyncMock(
        return_value=(canned_reply, "msg-id-fake", ["irb", "egfr"])
    )

    with (
        patch("apps.api.routes.get_supabase", return_value=fake_db),
        patch("apps.api.routes.llm_provider", fake_llm),
        # Patch the database module's getter for the A2A server routes that
        # bypass routes.py.
        patch("apps.api.database.get_supabase", return_value=fake_db),
        patch("apps.api.quorum_a2a.a2a_server.get_supabase", return_value=fake_db),
        patch(
            "apps.api.quorum_a2a.a2a_client.A2AClient.get_agent_url",
            return_value=_AGENT_ENDPOINT_B["url"],
        ),
        # Patch process_agent_turn at both qualified and bare paths so the
        # late `from agent_engine import process_agent_turn` inside the
        # A2A server handler picks up the stub.
        patch("apps.api.agent_engine.process_agent_turn", new=fake_process_agent_turn),
        patch("agent_engine.process_agent_turn", new=fake_process_agent_turn),
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
    ):
        import importlib
        import apps.api.main as main_mod

        importlib.reload(main_mod)
        client = TestClient(main_mod.app, raise_server_exceptions=False)
        yield client, fake_db


# ---------------------------------------------------------------------------
# 1+2. AgentCard endpoints
# ---------------------------------------------------------------------------

class TestAgentCardEndpoint:
    def test_well_known_agent_card_returns_spec_fields(self, a2a_app):
        client, _ = a2a_app
        resp = client.get(f"/a2a/agents/{_ROLE_B_ID}/.well-known/agent-card.json")
        assert resp.status_code == 200, resp.text
        card = resp.json()
        # Required spec fields per LF A2A 1.0
        assert "name" in card and card["name"]
        assert "description" in card
        assert "version" in card and card["version"]
        assert "capabilities" in card
        # v1.0 puts URL inside supportedInterfaces (camelCase via the SDK)
        interfaces = card.get("supportedInterfaces") or []
        assert interfaces, f"missing supportedInterfaces in card: {card}"
        assert "url" in interfaces[0]
        assert _ROLE_B_ID in interfaces[0]["url"]
        # Skills present and have id + name
        assert "skills" in card and card["skills"]
        first_skill = card["skills"][0]
        assert "id" in first_skill and "name" in first_skill

    def test_agent_card_enriched_from_agent_config(self, a2a_app):
        client, _ = a2a_app
        resp = client.get(f"/a2a/agents/{_ROLE_B_ID}/.well-known/agent-card.json")
        card = resp.json()
        # Description must be the generic, non-leaky string — it should NOT
        # contain any slice of the architect-authored system_prompt.
        # The role name (`irb_officer`) is public (it's in the routing URL),
        # so it may appear; the system_prompt's wording (e.g. "IRB officer
        # for this clinical trial") must NOT.
        assert "IRB officer" not in card["description"]
        assert "clinical trial" not in card["description"]
        # Skill tags should reflect domain_tags from agent_config (these are
        # architect-curated discovery tags, not persona-leaking prose).
        skill_tags = card["skills"][0].get("tags", [])
        assert "irb" in skill_tags
        assert "regulatory" in skill_tags

    def test_agent_card_description_does_not_leak_system_prompt(self, a2a_app):
        """SECURITY: the public AgentCard must not echo any keyword that is
        unique to the architect-authored system_prompt. Audit: PR #14."""
        client, _ = a2a_app
        resp = client.get(f"/a2a/agents/{_ROLE_B_ID}/.well-known/agent-card.json")
        card = resp.json()
        # Keywords that appear in the system_prompt fixture but should never
        # surface via the unauthenticated card.
        leaky_keywords = [
            "clinical trial",
            "regulatory references",
            "Review safety questions",
        ]
        for keyword in leaky_keywords:
            assert keyword.lower() not in card["description"].lower(), (
                f"description leaks system_prompt keyword {keyword!r}: "
                f"{card['description']!r}"
            )

    def test_agent_card_x_quorum_does_not_expose_authority_rank(self, a2a_app):
        """SECURITY: x-quorum extension must NOT include authority_rank.
        Consumers needing rank must fetch it via the access-gated authority
        MCP server. Audit: PR #14."""
        client, _ = a2a_app
        resp = client.get(f"/a2a/agents/{_ROLE_B_ID}/.well-known/agent-card.json")
        card = resp.json()
        assert "x-quorum" in card
        assert "authority_rank" not in card["x-quorum"]
        # And it must not appear anywhere in the raw response body either —
        # the fixture role has authority_rank=5, so guard against any reintro
        # via the skill description or other fields.
        body_text = resp.text.lower()
        assert "authority_rank" not in body_text
        assert "authority rank" not in body_text

    def test_agent_card_skills_contain_only_generic_capabilities(self, a2a_app):
        """SECURITY: skills must describe capability surface, not persona
        behavior. Audit: PR #14."""
        client, _ = a2a_app
        resp = client.get(f"/a2a/agents/{_ROLE_B_ID}/.well-known/agent-card.json")
        card = resp.json()
        skill = card["skills"][0]
        # No persona keywords or authority rank text in the skill description.
        skill_desc = skill.get("description", "").lower()
        assert "clinical trial" not in skill_desc
        assert "regulatory references" not in skill_desc
        assert "authority rank" not in skill_desc
        assert "overrides" not in skill_desc

    def test_legacy_agent_json_alias_serves_identical_content(self, a2a_app):
        client, _ = a2a_app
        canon = client.get(
            f"/a2a/agents/{_ROLE_B_ID}/.well-known/agent-card.json"
        ).json()
        alias = client.get(
            f"/a2a/agents/{_ROLE_B_ID}/.well-known/agent.json"
        ).json()
        assert canon == alias

    def test_unknown_role_returns_404(self, a2a_app):
        client, _ = a2a_app
        resp = client.get("/a2a/agents/nonexistent-role/.well-known/agent-card.json")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 3+4. tasks/send and message:send
# ---------------------------------------------------------------------------

class TestTasksSendEndpoint:
    def _send_body(self, text: str) -> dict[str, Any]:
        return {
            "message": {
                "messageId": str(uuid.uuid4()),
                "role": "ROLE_USER",
                "parts": [{"text": text}],
            }
        }

    def test_tasks_send_returns_completed_task_with_reply(self, a2a_app):
        client, _ = a2a_app
        resp = client.post(
            f"/a2a/agents/{_ROLE_B_ID}/tasks/send",
            json=self._send_body("What is the eGFR cut-off?"),
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "task" in body, f"missing task in response: {body}"
        task = body["task"]
        assert task["status"]["state"] == "TASK_STATE_COMPLETED"
        # The reply should appear in either the artifacts or history.
        text_chunks = []
        for art in task.get("artifacts", []):
            for part in art.get("parts", []):
                if "text" in part:
                    text_chunks.append(part["text"])
        for msg in task.get("history", []):
            for part in msg.get("parts", []):
                if "text" in part:
                    text_chunks.append(part["text"])
        joined = " ".join(text_chunks)
        assert "eGFR" in joined or "IRB" in joined, (
            f"agent reply not surfaced in response: {body}"
        )

    def test_message_send_canonical_path_works(self, a2a_app):
        client, _ = a2a_app
        resp = client.post(
            f"/a2a/agents/{_ROLE_B_ID}/message:send",
            json=self._send_body("Confirm protocol amendment 3"),
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body.get("task", {}).get("status", {}).get("state") == "TASK_STATE_COMPLETED"

    def test_tasks_send_unknown_role_returns_404(self, a2a_app):
        client, _ = a2a_app
        resp = client.post(
            "/a2a/agents/no-such-role/tasks/send",
            json=self._send_body("ping"),
        )
        assert resp.status_code == 404

    def test_tasks_send_invalid_body_returns_400(self, a2a_app):
        client, _ = a2a_app
        resp = client.post(
            f"/a2a/agents/{_ROLE_B_ID}/tasks/send",
            json={"not a valid": "send message body"},
        )
        # Either 400 (no message) or 200 with a graceful empty-input reply —
        # our handler accepts the v0.3-style top-level message and only 400s
        # if no message can be derived AT ALL.  Here the body is bare, so the
        # ParseDict / HasField check fires.
        assert resp.status_code in (400, 422)


# ---------------------------------------------------------------------------
# 5. Client → server end-to-end via FastAPI test client (no real network)
# ---------------------------------------------------------------------------

class TestA2AClientEndToEnd:
    @pytest.mark.asyncio
    async def test_client_posts_task_and_receives_reply(self, a2a_app):
        """Agent A's client POSTs a task to agent B and reads back the reply.

        Uses TestClient under the hood — no real TCP socket.  This exercises
        the full path: A2AClient.send_message → httpx → FastAPI route →
        agent_engine → wrap reply → A2AClient parses response.
        """
        client, _ = a2a_app
        from quorum_a2a.a2a_client import A2AClient

        # Inject a transport that proxies httpx calls through TestClient.
        # httpx supports a custom transport via its `transport` arg, but the
        # simplest hermetic approach is to patch httpx.AsyncClient.post to
        # call the TestClient directly.
        async_test_post = AsyncMock()

        def _sync_post(url: str, **kwargs: Any):
            # url comes through as fully-qualified ``http://testserver/...``
            from urllib.parse import urlparse

            parsed = urlparse(url)
            return client.post(parsed.path, json=kwargs.get("json"))

        # Wrap the sync TestClient call in an async-friendly mock that mimics
        # httpx.Response (we only need .status_code and .json()).
        class _AsyncCM:
            async def __aenter__(self_inner):
                return self_inner

            async def __aexit__(self_inner, *a, **kw):
                return None

            async def post(self_inner, url, **kw):
                tc_resp = _sync_post(url, **kw)
                fake = MagicMock()
                fake.status_code = tc_resp.status_code
                fake.json = lambda: tc_resp.json()
                return fake

        # The A2AClient creates AsyncClient(timeout=...) per call, so patch
        # the constructor to return our async context manager.
        with patch("quorum_a2a.a2a_client.httpx.AsyncClient", return_value=_AsyncCM()):
            a_client = A2AClient(timeout_s=2.0, max_retries=1)
            result = await a_client.send_message(
                target_role_id=_ROLE_B_ID,
                message={"message": "What is the eGFR cut-off?"},
            )

        assert result is not None, "client returned None — task-send round-trip failed"
        # Result should be the parsed SendMessageResponse.
        task = result.get("task")
        assert task is not None, f"no task in result: {result}"
        assert task["status"]["state"] == "TASK_STATE_COMPLETED"


# ---------------------------------------------------------------------------
# 6. lookup_endpoint reads from agent_endpoints
# ---------------------------------------------------------------------------

class TestLookupEndpoint:
    def test_lookup_endpoint_returns_url_from_table(self, a2a_app):
        _, fake_db = a2a_app
        # Bypass the per-process registry by clearing it, so we exercise the
        # DB fall-through path.
        from quorum_a2a.a2a_client import _agent_registry
        from quorum_a2a.a2a_server import lookup_endpoint

        _agent_registry.clear()
        url = lookup_endpoint(_ROLE_B_ID, db=fake_db)
        assert url == _AGENT_ENDPOINT_B["url"]

    def test_lookup_endpoint_returns_none_for_unknown(self, a2a_app):
        _, fake_db = a2a_app
        from quorum_a2a.a2a_server import lookup_endpoint

        url = lookup_endpoint("does-not-exist", db=fake_db)
        assert url is None

    def test_lookup_endpoint_swallows_missing_table(self):
        """If the DB raises (missing table), lookup_endpoint returns None."""
        from quorum_a2a.a2a_server import lookup_endpoint

        broken_db = MagicMock()
        broken_db.table.side_effect = Exception("relation 'agent_endpoints' does not exist")
        assert lookup_endpoint("anything", db=broken_db) is None
