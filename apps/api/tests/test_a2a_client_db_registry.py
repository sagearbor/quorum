"""Coverage for the DB-backed endpoint lookup in A2AClient (checklist 11.5).

The previous implementation read endpoints from a process-local
``_agent_registry`` dict. That worked for unit tests but broke across
uvicorn workers — only the worker that registered the role saw the URL.

The new implementation:
  1. ``_agent_registry`` is retained as a TEST-INJECTION map (highest
     precedence) so tests can override without a DB write.
  2. A per-process TTL cache fronts the DB to avoid a round-trip on every
     dispatch.
  3. The ``agent_endpoints`` table is the source of truth.

These tests verify each layer behaves as advertised.
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest


_ROLE_ID = "role-db-reg"
_DB_URL = "http://db-registered.test/a2a/agents/" + _ROLE_ID
_TEST_INJECTED_URL = "http://injected.test/a2a/agents/" + _ROLE_ID


@pytest.fixture(autouse=True)
def _reset_state():
    """Clear both the test-injection dict and the TTL cache between tests."""
    from quorum_a2a.a2a_client import _agent_registry, _cache_clear

    _agent_registry.clear()
    _cache_clear()
    yield
    _agent_registry.clear()
    _cache_clear()


# ---------------------------------------------------------------------------
# Lookup precedence: injection > cache > DB
# ---------------------------------------------------------------------------


def test_register_agent_takes_precedence_over_db():
    """When both injection and DB have a URL, injection wins (test ergonomics)."""
    from quorum_a2a.a2a_client import A2AClient

    client = A2AClient()
    client.register_agent(_ROLE_ID, _TEST_INJECTED_URL)

    with patch("quorum_a2a.a2a_server.lookup_endpoint", return_value=_DB_URL):
        assert client.get_agent_url(_ROLE_ID) == _TEST_INJECTED_URL


def test_register_agent_invalidates_cache():
    """Calling register_agent must drop any stale cached DB result so the
    test override takes effect immediately."""
    from quorum_a2a.a2a_client import A2AClient

    client = A2AClient()

    # Prime cache from a DB call.
    with patch("quorum_a2a.a2a_server.lookup_endpoint", return_value=_DB_URL):
        first = client.get_agent_url(_ROLE_ID)
    assert first == _DB_URL

    # Now inject something different. The cache for this role must be cleared.
    client.register_agent(_ROLE_ID, _TEST_INJECTED_URL)
    assert client.get_agent_url(_ROLE_ID) == _TEST_INJECTED_URL


def test_db_lookup_used_when_registry_empty():
    """Bare A2AClient with nothing injected should hit lookup_endpoint."""
    from quorum_a2a.a2a_client import A2AClient

    client = A2AClient()
    with patch(
        "quorum_a2a.a2a_server.lookup_endpoint", return_value=_DB_URL
    ) as lookup:
        result = client.get_agent_url(_ROLE_ID)

    assert result == _DB_URL
    assert lookup.call_count == 1


# ---------------------------------------------------------------------------
# TTL cache behaviour
# ---------------------------------------------------------------------------


def test_cache_avoids_repeated_db_lookups():
    """Two lookups in quick succession should hit the DB once."""
    from quorum_a2a.a2a_client import A2AClient

    client = A2AClient()
    with patch(
        "quorum_a2a.a2a_server.lookup_endpoint", return_value=_DB_URL
    ) as lookup:
        assert client.get_agent_url(_ROLE_ID) == _DB_URL
        assert client.get_agent_url(_ROLE_ID) == _DB_URL
        assert client.get_agent_url(_ROLE_ID) == _DB_URL

    assert lookup.call_count == 1


def test_cache_expires_after_ttl(monkeypatch):
    """When the TTL elapses, the next lookup re-hits the DB."""
    from quorum_a2a import a2a_client as mod
    from quorum_a2a.a2a_client import A2AClient

    # Drop the TTL to effectively zero for this test by manipulating monotonic.
    fake_now = [1000.0]

    def _now() -> float:
        return fake_now[0]

    monkeypatch.setattr(mod.time, "monotonic", _now)

    client = A2AClient()
    with patch(
        "quorum_a2a.a2a_server.lookup_endpoint", return_value=_DB_URL
    ) as lookup:
        assert client.get_agent_url(_ROLE_ID) == _DB_URL
        # Same monotonic time → cache hit.
        assert client.get_agent_url(_ROLE_ID) == _DB_URL
        # Advance past the TTL.
        fake_now[0] += mod._ENDPOINT_TTL_S + 1.0
        # Now expired → second DB lookup.
        assert client.get_agent_url(_ROLE_ID) == _DB_URL

    assert lookup.call_count == 2


def test_cache_does_not_store_negative_results():
    """A None DB result must NOT be cached — otherwise registering a role
    after the first failed lookup would be invisible until the TTL expires.
    """
    from quorum_a2a.a2a_client import A2AClient

    client = A2AClient()
    with patch("quorum_a2a.a2a_server.lookup_endpoint", return_value=None) as lookup:
        assert client.get_agent_url(_ROLE_ID) is None
        assert client.get_agent_url(_ROLE_ID) is None

    # Both calls hit the DB — no negative caching.
    assert lookup.call_count == 2


# ---------------------------------------------------------------------------
# DB lookup tolerance: a thrown exception must NOT propagate
# ---------------------------------------------------------------------------


def test_db_lookup_failure_returns_none_without_caching():
    """If lookup_endpoint raises (table missing, network), get_agent_url
    returns None and does not poison the cache."""
    from quorum_a2a.a2a_client import A2AClient, _cache_get

    client = A2AClient()
    with patch(
        "quorum_a2a.a2a_server.lookup_endpoint",
        side_effect=RuntimeError("boom"),
    ):
        assert client.get_agent_url(_ROLE_ID) is None

    assert _cache_get(_ROLE_ID) is None
