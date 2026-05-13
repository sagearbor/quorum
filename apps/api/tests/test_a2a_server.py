"""Security regression tests for the A2A server endpoints.

Audit finding (PR #14):
The ``/agents/{role_id}/message:send`` (and ``/tasks/send`` alias) handler
used to interpolate ``str(exc)`` into the SendMessageResponse reply text
when the inner agent turn raised. The endpoint is unauthenticated and the
reply is serialized straight back over the wire, so anything in the
exception message — partial API keys, internal URLs, DB row contents,
table names — would leak to whoever could reach the endpoint.

This test forces ``process_agent_turn`` to raise with a recognisable
"secret" marker in the exception message and asserts that the marker
does NOT appear anywhere in the response body. Only the static fallback
string ``"Agent turn unavailable. Please retry."`` is allowed through.
"""

from __future__ import annotations

import importlib
import json
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


_QUORUM_ID = "quorum-leak-test"
_ROLE_ID = "role-leak-test"

_ROLE = {
    "id": _ROLE_ID,
    "quorum_id": _QUORUM_ID,
    "name": "irb_officer",
    "authority_rank": 5,
    "capacity": "1",
}
_AGENT_CONFIG = {
    "role_id": _ROLE_ID,
    "system_prompt": "You are the IRB officer.",
    "domain_tags": ["irb"],
    "agent_slug": "irb_officer",
}
_AGENT_ENDPOINT = {
    "role_id": _ROLE_ID,
    "url": f"http://testserver/a2a/agents/{_ROLE_ID}",
    "capabilities": {"name": "irb_officer", "authority_rank": 5},
}


def _make_fake_supabase(overrides: dict[str, list[dict[str, Any]]] | None = None) -> MagicMock:
    """Filter-aware Supabase mock — copied from test_a2a_protocol so this
    test is self-contained and the leak surface is exercised end-to-end.
    """
    overrides = overrides or {}

    def _table_builder(table_name: str):
        rows = list(overrides.get(table_name, []))
        state: dict[str, Any] = {"single": False, "filters": []}
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
            result.data = (filtered[0] if filtered else None) if state["single"] else filtered
            return result

        chain.execute = _execute
        return chain

    db = MagicMock()
    db.table.side_effect = _table_builder
    return db


@pytest.fixture()
def a2a_app_with_failing_turn():
    """A2A app where the inner agent turn always raises with a leaky message."""
    from fastapi.testclient import TestClient

    fake_db = _make_fake_supabase({
        "quorums": [{"id": _QUORUM_ID, "title": "Leak Test", "description": ""}],
        "roles": [_ROLE],
        "agent_configs": [_AGENT_CONFIG],
        "agent_endpoints": [_AGENT_ENDPOINT],
        "station_messages": [],
        "agent_insights": [],
        "agent_documents": [],
        "agent_requests": [],
        "contributions": [],
    })

    # Force the inner agent turn to raise an exception whose ``str(exc)``
    # contains every kind of sensitive token an attacker might fish for.
    secret_message = (
        "AZURE_OPENAI_API_KEY=sk-leak-AAAAAAAAAA "
        "host=internal-db.svc.cluster.local "
        "table=station_messages row_id=00000000-1111-2222-3333-444444444444 "
        "Traceback File '/srv/secret/path/agent_engine.py' line 999"
    )
    raising_turn = AsyncMock(side_effect=RuntimeError(secret_message))

    with (
        patch("apps.api.routes.get_supabase", return_value=fake_db),
        patch("apps.api.database.get_supabase", return_value=fake_db),
        patch("apps.api.quorum_a2a.a2a_server.get_supabase", return_value=fake_db),
        patch("apps.api.agent_engine.process_agent_turn", new=raising_turn),
        patch("agent_engine.process_agent_turn", new=raising_turn),
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
    ):
        import apps.api.main as main_mod
        importlib.reload(main_mod)
        client = TestClient(main_mod.app, raise_server_exceptions=False)
        yield client, secret_message


def _send_body(text: str) -> dict[str, Any]:
    return {
        "message": {
            "messageId": str(uuid.uuid4()),
            "role": "ROLE_USER",
            "parts": [{"text": text}],
        }
    }


class TestA2AMessageSendDoesNotLeakExceptionText:
    """Audit finding: /message:send and /tasks/send must not leak exc text."""

    def test_message_send_does_not_leak_exception_text(self, a2a_app_with_failing_turn):
        client, secret_message = a2a_app_with_failing_turn
        resp = client.post(
            f"/a2a/agents/{_ROLE_ID}/message:send",
            json=_send_body("trigger a failure"),
        )
        # Even though the inner turn raised, the handler swallows it and
        # returns a 200 OK with the static fallback string.
        assert resp.status_code == 200, resp.text
        body_text = json.dumps(resp.json())

        # The static fallback MUST be present.
        assert "Agent turn unavailable" in body_text, (
            f"static fallback string missing from response body: {body_text}"
        )

        # Every keyword from the raised exception MUST be absent.
        leaky_tokens = [
            "AZURE_OPENAI_API_KEY",
            "sk-leak-",
            "internal-db.svc.cluster.local",
            "station_messages",
            "00000000-1111-2222-3333-444444444444",
            "Traceback",
            "/srv/secret/path/agent_engine.py",
            "RuntimeError",
        ]
        for token in leaky_tokens:
            assert token not in body_text, (
                f"exception-leak detected: token {token!r} appears in A2A response body. "
                f"Response: {body_text}"
            )

        # Defensive: the literal raised message must not appear either.
        assert secret_message not in body_text

    def test_tasks_send_alias_does_not_leak_exception_text(self, a2a_app_with_failing_turn):
        """The v0.3 ``/tasks/send`` alias shares the handler — same guarantee."""
        client, _secret_message = a2a_app_with_failing_turn
        resp = client.post(
            f"/a2a/agents/{_ROLE_ID}/tasks/send",
            json=_send_body("trigger a failure"),
        )
        assert resp.status_code == 200, resp.text
        body_text = json.dumps(resp.json())
        assert "Agent turn unavailable" in body_text
        assert "AZURE_OPENAI_API_KEY" not in body_text
        assert "internal-db.svc.cluster.local" not in body_text
