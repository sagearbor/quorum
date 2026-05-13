"""Transport-level tests for the A2A httpx client.

These verify the failure-mode contract: 2xx returns a parsed body, 5xx
exhausts retries then returns None, timeouts behave the same, and the retry
count never exceeds what was configured.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest


_ROLE_ID = "role-client-http"
_ENDPOINT_URL = "http://example.test/a2a/agents/" + _ROLE_ID


@pytest.fixture(autouse=True)
def _register_endpoint():
    """Inject a process-local endpoint for the test role.

    Uses the in-process ``_agent_registry`` so we don't need a real DB —
    this is exactly what test fixtures should look like per the module
    docstring on ``register_agent``.
    """
    from quorum_a2a.a2a_client import _agent_registry

    _agent_registry.clear()
    _agent_registry[_ROLE_ID] = _ENDPOINT_URL
    yield
    _agent_registry.clear()


def _make_async_cm(post_mock: AsyncMock):
    """Build an async context manager wrapper around an AsyncMock for post()."""

    class _Wrapper:
        async def __aenter__(self):
            inst = MagicMock()
            inst.post = post_mock
            return inst

        async def __aexit__(self, *args):
            return None

    return _Wrapper()


class TestSendMessageSuccess:
    @pytest.mark.asyncio
    async def test_2xx_returns_parsed_body(self):
        from quorum_a2a.a2a_client import A2AClient

        success_body = {
            "task": {
                "id": "t-1",
                "contextId": "ctx-1",
                "status": {"state": "TASK_STATE_COMPLETED"},
                "artifacts": [{"parts": [{"text": "ok"}]}],
            }
        }
        fake_resp = MagicMock()
        fake_resp.status_code = 200
        fake_resp.json = lambda: success_body

        post_mock = AsyncMock(return_value=fake_resp)
        with patch(
            "quorum_a2a.a2a_client.httpx.AsyncClient",
            return_value=_make_async_cm(post_mock),
        ):
            client = A2AClient(timeout_s=0.5, max_retries=1)
            result = await client.send_message(_ROLE_ID, {"message": "ping"})

        assert result is not None
        # Result should include the task (parsed via SDK proto round-trip).
        assert result.get("task", {}).get("status", {}).get("state") == "TASK_STATE_COMPLETED"
        # Exactly one POST since we got 2xx on first attempt.
        assert post_mock.call_count == 1


class TestSendMessageFailureModes:
    @pytest.mark.asyncio
    async def test_500_retries_then_returns_none(self):
        from quorum_a2a.a2a_client import A2AClient

        fail_resp = MagicMock()
        fail_resp.status_code = 500
        fail_resp.json = lambda: {"error": "boom"}
        post_mock = AsyncMock(return_value=fail_resp)

        with patch(
            "quorum_a2a.a2a_client.httpx.AsyncClient",
            return_value=_make_async_cm(post_mock),
        ):
            client = A2AClient(
                timeout_s=0.5,
                max_retries=3,
                backoff_base_s=0.0,  # collapse backoff for fast tests
            )
            result = await client.send_message(_ROLE_ID, {"message": "ping"})

        assert result is None
        # Exactly max_retries POSTs — no infinite retry storm.
        assert post_mock.call_count == 3

    @pytest.mark.asyncio
    async def test_timeout_retries_then_returns_none(self):
        from quorum_a2a.a2a_client import A2AClient

        post_mock = AsyncMock(side_effect=httpx.TimeoutException("slow agent"))
        with patch(
            "quorum_a2a.a2a_client.httpx.AsyncClient",
            return_value=_make_async_cm(post_mock),
        ):
            client = A2AClient(
                timeout_s=0.1,
                max_retries=2,
                backoff_base_s=0.0,
            )
            result = await client.send_message(_ROLE_ID, {"message": "ping"})

        assert result is None
        assert post_mock.call_count == 2

    @pytest.mark.asyncio
    async def test_4xx_fails_fast_no_retry(self):
        """A 4xx (bad request) should not be retried — the body is the bug."""
        from quorum_a2a.a2a_client import A2AClient

        fail_resp = MagicMock()
        fail_resp.status_code = 400
        fail_resp.json = lambda: {"error": "bad message"}
        post_mock = AsyncMock(return_value=fail_resp)

        with patch(
            "quorum_a2a.a2a_client.httpx.AsyncClient",
            return_value=_make_async_cm(post_mock),
        ):
            client = A2AClient(
                timeout_s=0.5,
                max_retries=5,
                backoff_base_s=0.0,
            )
            result = await client.send_message(_ROLE_ID, {"message": "ping"})

        assert result is None
        # 4xx should NOT trigger retries.
        assert post_mock.call_count == 1

    @pytest.mark.asyncio
    async def test_no_endpoint_returns_none_without_http_call(self):
        """When the role has no registered endpoint, no HTTP call is made."""
        from quorum_a2a.a2a_client import A2AClient, _agent_registry

        _agent_registry.clear()
        post_mock = AsyncMock()

        with patch(
            "quorum_a2a.a2a_client.httpx.AsyncClient",
            return_value=_make_async_cm(post_mock),
        ):
            with patch(
                "quorum_a2a.a2a_server.lookup_endpoint",
                return_value=None,
            ):
                client = A2AClient(timeout_s=0.5, max_retries=3, backoff_base_s=0.0)
                result = await client.send_message("missing-role", {"message": "x"})

        assert result is None
        assert post_mock.call_count == 0


class TestPayloadShape:
    @pytest.mark.asyncio
    async def test_legacy_dict_is_wrapped_in_v1_send_message_request(self):
        """A legacy `{"type": ..., "message": "..."}` dict must hit the wire
        as a v1.0 SendMessageRequest with `message.parts[].text`."""
        from quorum_a2a.a2a_client import A2AClient

        captured: dict[str, Any] = {}
        fake_resp = MagicMock()
        fake_resp.status_code = 200
        fake_resp.json = lambda: {
            "task": {
                "id": "t-1",
                "contextId": "ctx-1",
                "status": {"state": "TASK_STATE_COMPLETED"},
            }
        }

        async def _capture_post(url, **kwargs):
            captured["url"] = url
            captured["json"] = kwargs.get("json")
            return fake_resp

        post_mock = AsyncMock(side_effect=_capture_post)
        with patch(
            "quorum_a2a.a2a_client.httpx.AsyncClient",
            return_value=_make_async_cm(post_mock),
        ):
            client = A2AClient(timeout_s=0.5, max_retries=1)
            await client.send_message(
                _ROLE_ID,
                {"type": "architect_guidance", "message": "focus on safety"},
            )

        assert "/message:send" in captured["url"], (
            f"client appended wrong path: {captured['url']}"
        )
        body = captured["json"]
        assert "message" in body, f"non-spec payload: {body}"
        # v1.0 uses parts[].text, NOT content/text/data.
        parts = body["message"]["parts"]
        assert any(p.get("text") == "focus on safety" for p in parts), (
            f"text not surfaced into parts: {parts}"
        )
