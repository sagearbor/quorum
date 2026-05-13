"""Tests for the OpenAI Realtime + Whisper-fallback endpoints used by the
Architect mic UI.

Coverage:
  - 401 when OPENAI_API_KEY is missing
  - Happy path: POST /architect/realtime/session returns the ephemeral
    client_secret + expires_at and forwards the configured model/voice
  - Override path: explicit body model+voice overrides env defaults
  - Tool schema is sent to OpenAI in the session config
  - Backward-compat: also handles the older `{client_secret: {value, …}}`
    response shape
  - 502 on OpenAI 4xx / 5xx
  - Whisper fallback: empty upload → 400; oversize → 413
  - Whisper happy path forwards the audio to /v1/audio/transcriptions and
    returns the text
"""

from __future__ import annotations

import importlib
import io
import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fresh_client(monkeypatch, env: dict[str, str] | None = None):
    """Reload apps.api.main + apps.api.voice_routes under the given env so module-
    level constants (OPENAI_API_BASE, defaults) pick up overrides, then return
    a fastapi TestClient bound to the fresh app.
    """
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)

    # Make sure the routes/seed loader don't try to actually hit Supabase
    from fastapi.testclient import TestClient
    import apps.api.voice_routes as realtime_mod
    import apps.api.main as main_mod

    importlib.reload(realtime_mod)
    importlib.reload(main_mod)
    return TestClient(main_mod.app, raise_server_exceptions=False)


def _mock_async_post(response: MagicMock):
    """Build a context-manager-aware AsyncClient mock whose .post() returns
    `response`."""
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(return_value=response)
    return mock_client


def _mk_response(status: int, payload: dict | str):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    if isinstance(payload, str):
        resp.text = payload
        resp.json = MagicMock(side_effect=ValueError("not json"))
    else:
        resp.text = json.dumps(payload)
        resp.json = MagicMock(return_value=payload)
    return resp


# ---------------------------------------------------------------------------
# /architect/realtime/session
# ---------------------------------------------------------------------------


def test_realtime_session_401_when_no_api_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()):
        client = _fresh_client(monkeypatch)
        resp = client.post("/architect/realtime/session", json={})
    assert resp.status_code == 401, resp.text
    assert "OPENAI_API_KEY" in resp.json()["detail"]


def test_realtime_session_happy_path_returns_ephemeral_token(monkeypatch):
    """Backend should POST to OpenAI with our key, then return the ephemeral
    `value` to the caller."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-server-key")

    fake_resp = _mk_response(
        200,
        {
            "value": "ek_abc123",
            "expires_at": 1747000000,
        },
    )
    mock_client = _mock_async_post(fake_resp)

    with (
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
        patch("apps.api.voice_routes.httpx.AsyncClient", return_value=mock_client),
    ):
        client = _fresh_client(monkeypatch)
        resp = client.post("/architect/realtime/session", json={})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["client_secret"] == "ek_abc123"
    assert body["expires_at"] == 1747000000
    assert body["model"] == "gpt-realtime"
    assert body["voice"] == "alloy"

    # Verify we hit the correct OpenAI endpoint with our server-side key
    call_args = mock_client.post.call_args
    url = call_args.args[0] if call_args.args else call_args.kwargs.get("url")
    assert url.endswith("/v1/realtime/client_secrets")
    headers = call_args.kwargs["headers"]
    assert headers["Authorization"] == "Bearer sk-test-server-key"
    sent_json = call_args.kwargs["json"]
    assert sent_json["session"]["type"] == "realtime"
    assert sent_json["session"]["model"] == "gpt-realtime"
    assert sent_json["session"]["audio"]["output"]["voice"] == "alloy"
    # Server MUST never echo the main API key to the browser
    assert "sk-test-server-key" not in resp.text


def test_realtime_session_request_body_overrides_env_defaults(monkeypatch):
    """If the request body specifies model/voice, those win over env."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("OPENAI_REALTIME_MODEL", "gpt-realtime")
    monkeypatch.setenv("OPENAI_REALTIME_VOICE", "alloy")

    fake_resp = _mk_response(200, {"value": "ek_xyz", "expires_at": 1})
    mock_client = _mock_async_post(fake_resp)

    with (
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
        patch("apps.api.voice_routes.httpx.AsyncClient", return_value=mock_client),
    ):
        client = _fresh_client(monkeypatch)
        resp = client.post(
            "/architect/realtime/session",
            json={"model": "gpt-realtime-mini", "voice": "marin"},
        )

    assert resp.status_code == 200, resp.text
    sent_json = mock_client.post.call_args.kwargs["json"]
    assert sent_json["session"]["model"] == "gpt-realtime-mini"
    assert sent_json["session"]["audio"]["output"]["voice"] == "marin"
    assert resp.json()["voice"] == "marin"


def test_realtime_session_default_tools_include_form_fill(monkeypatch):
    """The default architect toolset must include `set_event_metadata` so
    gpt-realtime can populate the form mid-conversation."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    fake_resp = _mk_response(200, {"value": "ek_x", "expires_at": 1})
    mock_client = _mock_async_post(fake_resp)
    with (
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
        patch("apps.api.voice_routes.httpx.AsyncClient", return_value=mock_client),
    ):
        client = _fresh_client(monkeypatch)
        resp = client.post("/architect/realtime/session", json={})
    assert resp.status_code == 200, resp.text
    tools = mock_client.post.call_args.kwargs["json"]["session"]["tools"]
    tool_names = {t["name"] for t in tools}
    assert "set_event_metadata" in tool_names
    assert "submit_form" in tool_names
    # Each tool must declare type="function" (Realtime API shape, NOT the
    # nested {function: {…}} shape that Chat Completions uses).
    assert all(t["type"] == "function" for t in tools)


def test_realtime_session_handles_preview_client_secret_response_shape(monkeypatch):
    """Older preview API returns `{client_secret: {value, expires_at}}`. We
    must still extract the value so we don't break if the project is on a
    pinned preview model."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    fake_resp = _mk_response(
        200,
        {"client_secret": {"value": "ek_preview", "expires_at": 99}},
    )
    mock_client = _mock_async_post(fake_resp)
    with (
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
        patch("apps.api.voice_routes.httpx.AsyncClient", return_value=mock_client),
    ):
        client = _fresh_client(monkeypatch)
        resp = client.post("/architect/realtime/session", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["client_secret"] == "ek_preview"
    assert resp.json()["expires_at"] == 99


def test_realtime_session_502_when_openai_errors(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    fake_resp = _mk_response(
        429,
        {"error": {"message": "rate limited", "type": "rate_limit_error"}},
    )
    mock_client = _mock_async_post(fake_resp)
    with (
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
        patch("apps.api.voice_routes.httpx.AsyncClient", return_value=mock_client),
    ):
        client = _fresh_client(monkeypatch)
        resp = client.post("/architect/realtime/session", json={})
    assert resp.status_code == 502, resp.text
    body = resp.json()["detail"]
    assert body["openai_status"] == 429
    assert "rate limited" in json.dumps(body)


def test_realtime_session_502_on_httpx_network_error(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(side_effect=httpx.ConnectError("dns lookup failed"))

    with (
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
        patch("apps.api.voice_routes.httpx.AsyncClient", return_value=mock_client),
    ):
        client = _fresh_client(monkeypatch)
        resp = client.post("/architect/realtime/session", json={})
    assert resp.status_code == 502, resp.text
    assert "Could not reach OpenAI" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# /architect/transcribe — Whisper fallback
# ---------------------------------------------------------------------------


def test_transcribe_401_when_no_api_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()):
        client = _fresh_client(monkeypatch)
        resp = client.post(
            "/architect/transcribe",
            files={"file": ("clip.webm", b"some-audio", "audio/webm")},
        )
    assert resp.status_code == 401


def test_transcribe_rejects_empty_upload(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    with patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()):
        client = _fresh_client(monkeypatch)
        resp = client.post(
            "/architect/transcribe",
            files={"file": ("clip.webm", b"", "audio/webm")},
        )
    assert resp.status_code == 400


def test_transcribe_rejects_oversize_upload(monkeypatch):
    """26 MB > the 25 MB OpenAI ceiling — we should reject BEFORE forwarding
    so we don't burn a round-trip."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    big = b"x" * (26 * 1024 * 1024)
    with patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()):
        client = _fresh_client(monkeypatch)
        resp = client.post(
            "/architect/transcribe",
            files={"file": ("big.webm", big, "audio/webm")},
        )
    assert resp.status_code == 413


def test_transcribe_happy_path(monkeypatch):
    """Audio blob forwarded to /v1/audio/transcriptions; text returned to caller."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    fake_resp = _mk_response(200, {"text": "Hello world", "language": "en"})
    mock_client = _mock_async_post(fake_resp)

    with (
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
        patch("apps.api.voice_routes.httpx.AsyncClient", return_value=mock_client),
    ):
        client = _fresh_client(monkeypatch)
        resp = client.post(
            "/architect/transcribe",
            files={"file": ("clip.webm", b"\x1aE\xdf\xa3" + b"audio", "audio/webm")},
        )

    assert resp.status_code == 200, resp.text
    assert resp.json()["text"] == "Hello world"
    assert resp.json()["model"] == "whisper-1"

    # Verify we hit the correct endpoint with the form-data shape Whisper expects
    call = mock_client.post.call_args
    url = call.args[0] if call.args else call.kwargs.get("url")
    assert url.endswith("/v1/audio/transcriptions")
    assert "files" in call.kwargs
    assert call.kwargs["data"]["model"] == "whisper-1"


def test_transcribe_502_when_openai_errors(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    fake_resp = _mk_response(
        500, {"error": {"message": "server error"}}
    )
    mock_client = _mock_async_post(fake_resp)
    with (
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
        patch("apps.api.voice_routes.httpx.AsyncClient", return_value=mock_client),
    ):
        client = _fresh_client(monkeypatch)
        resp = client.post(
            "/architect/transcribe",
            files={"file": ("clip.webm", b"audio", "audio/webm")},
        )
    assert resp.status_code == 502
