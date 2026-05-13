"""Tests for the Logfire observability scaffolding in apps/api/main.py.

These tests guarantee three invariants:

1.  When ``LOGFIRE_TOKEN`` is NOT set, the FastAPI app boots cleanly. The
    ``logfire`` SDK is still ``configure()``-d with ``send_to_logfire=
    'if-token-present'`` — that's a documented Logfire no-op (no network),
    not a startup failure.

2.  When ``LOGFIRE_TOKEN`` IS set, ``logfire.configure()`` is invoked with the
    expected service identity (service_name, service_version,
    send_to_logfire), and ``logfire.instrument_fastapi(app)`` /
    ``logfire.instrument_pydantic_ai()`` are called exactly once each.

3.  When the ``logfire`` package isn't installed at all (ImportError),
    ``_configure_logfire`` returns ``False`` and never raises.  Sophie's
    minimal-CI Docker image must still start the API.

The tests run WITHOUT touching the network or sending data anywhere — we
inject a ``MagicMock`` into ``sys.modules['logfire']`` so the import inside
``_configure_logfire`` resolves to the mock, never the real SDK.
"""

from __future__ import annotations

import importlib
import logging
import sys
import types
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _install_fake_logfire(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Insert a fake ``logfire`` module into sys.modules and return it.

    The real Logfire SDK may or may not be installed in the test env; either
    way we want the function-under-test to import OUR mock so its calls are
    recorded.  monkeypatch undoes the swap at the end of the test.
    """
    fake = types.ModuleType("logfire")
    fake.configure = MagicMock(name="logfire.configure")
    fake.instrument_fastapi = MagicMock(name="logfire.instrument_fastapi")
    fake.instrument_pydantic_ai = MagicMock(name="logfire.instrument_pydantic_ai")
    # span() returns a usable context manager so any in-flight code that
    # happens to open a span during the test doesn't crash.
    fake.span = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
    monkeypatch.setitem(sys.modules, "logfire", fake)
    return fake


def _force_logfire_import_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make ``import logfire`` raise ImportError, regardless of install state.

    Implemented via a meta_path finder that returns ``None`` (= "not found")
    when asked for the ``logfire`` name, so even an installed SDK is hidden.
    """
    # Drop any cached real module so the next import re-runs the finder chain.
    monkeypatch.delitem(sys.modules, "logfire", raising=False)

    class _BlockLogfire:
        def find_spec(self, name, path=None, target=None):
            if name == "logfire" or name.startswith("logfire."):
                # Raising directly from find_spec gives a deterministic
                # ImportError at import time.
                raise ImportError("logfire blocked by test fixture")
            return None

    blocker = _BlockLogfire()
    monkeypatch.setattr(sys, "meta_path", [blocker] + sys.meta_path)


def _import_main_module():
    """Import apps/api/main.py without triggering its FastAPI app instantiation.

    main.py builds ``app = FastAPI(...)`` at module top level and immediately
    runs ``_configure_logfire(app)``, which is exactly what we want to
    observe.  We reload the module on every call so each test sees a fresh
    invocation against its own monkeypatched ``logfire`` mock.
    """
    if "main" in sys.modules:
        del sys.modules["main"]
    # conftest.py already added apps/api to sys.path and pre-installed the
    # quorum_llm / supabase mocks needed for main.py's import chain.
    return importlib.import_module("main")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_configure_logfire_runs_with_no_token(monkeypatch: pytest.MonkeyPatch, caplog):
    """Without LOGFIRE_TOKEN, configure() is still called (with the
    if-token-present sentinel) and the function returns True.

    This is the *normal* dev-mode path: Logfire is wired up but doesn't ship
    spans anywhere. We assert the call shape so a future refactor can't
    silently remove the send_to_logfire guard.
    """
    monkeypatch.delenv("LOGFIRE_TOKEN", raising=False)
    monkeypatch.delenv("LOGFIRE_SERVICE_NAME", raising=False)
    monkeypatch.delenv("QUORUM_VERSION", raising=False)

    fake_logfire = _install_fake_logfire(monkeypatch)

    main = _import_main_module()

    # configure() was called exactly once with the documented no-op pattern.
    assert fake_logfire.configure.call_count == 1, "logfire.configure must be called at boot"
    kwargs = fake_logfire.configure.call_args.kwargs
    assert kwargs.get("service_name") == "quorum-api"
    assert kwargs.get("service_version") == "dev"
    assert kwargs.get("send_to_logfire") == "if-token-present", (
        "send_to_logfire MUST be 'if-token-present' so the SDK is a no-op without a token"
    )

    # Auto-instrumentation still runs — without a token the spans simply
    # aren't shipped, but the OTel pipeline must be wired so manual spans
    # elsewhere in the codebase don't crash.
    fake_logfire.instrument_fastapi.assert_called_once()
    fake_logfire.instrument_pydantic_ai.assert_called_once()

    # And the public helper reports success.
    assert main._configure_logfire(main.app) is True


def test_configure_logfire_uses_token_and_version_envvars(monkeypatch: pytest.MonkeyPatch):
    """When LOGFIRE_TOKEN is set, service identity vars flow into configure()."""
    monkeypatch.setenv("LOGFIRE_TOKEN", "dummy-write-token")
    monkeypatch.setenv("QUORUM_VERSION", "git-abc1234")
    monkeypatch.setenv("LOGFIRE_SERVICE_NAME", "quorum-api-staging")

    fake_logfire = _install_fake_logfire(monkeypatch)

    main = _import_main_module()

    kwargs = fake_logfire.configure.call_args.kwargs
    assert kwargs.get("service_name") == "quorum-api-staging"
    assert kwargs.get("service_version") == "git-abc1234"
    # send_to_logfire stays 'if-token-present' regardless — the token env
    # var alone is what flips Logfire into shipping mode.  We never pass
    # the token literal to configure() (Logfire reads LOGFIRE_TOKEN itself).
    assert kwargs.get("send_to_logfire") == "if-token-present"
    assert "token" not in kwargs, "API code must not forward LOGFIRE_TOKEN explicitly — Logfire reads it from env"

    fake_logfire.instrument_fastapi.assert_called_once()
    fake_logfire.instrument_pydantic_ai.assert_called_once()


def test_configure_logfire_no_op_when_package_missing(monkeypatch: pytest.MonkeyPatch, caplog):
    """If the logfire package isn't installed, the function must return False
    and the app must still boot.  This protects the minimal CI image.
    """
    monkeypatch.delenv("LOGFIRE_TOKEN", raising=False)
    _force_logfire_import_error(monkeypatch)

    # Importing main triggers _configure_logfire(app) — this MUST NOT raise.
    with caplog.at_level(logging.INFO, logger="main"):
        main = _import_main_module()

    assert isinstance(main.app, FastAPI), "FastAPI app must instantiate even without logfire"
    # And a fresh manual call also returns False without raising.
    assert main._configure_logfire(main.app) is False


def test_configure_logfire_swallows_configure_errors(monkeypatch: pytest.MonkeyPatch):
    """If logfire.configure() itself raises (unexpected SDK bug, network
    glitch during local-credentials probe), the function logs and returns
    False — observability MUST NEVER break the API boot path.
    """
    monkeypatch.delenv("LOGFIRE_TOKEN", raising=False)

    fake_logfire = _install_fake_logfire(monkeypatch)
    fake_logfire.configure.side_effect = RuntimeError("simulated SDK boot failure")

    main = _import_main_module()

    # The app still came up — that's the contract.
    assert isinstance(main.app, FastAPI)
    # And the public helper reports the degraded state to callers that care.
    fake_logfire.configure.side_effect = RuntimeError("simulated SDK boot failure")
    assert main._configure_logfire(main.app) is False


def test_obs_span_is_noop_without_logfire(monkeypatch: pytest.MonkeyPatch):
    """The _obs.span() shim must be a usable context manager even when the
    logfire package isn't importable.  This is what keeps manual spans
    sprinkled through the autonomy loop safe.
    """
    _force_logfire_import_error(monkeypatch)
    if "_obs" in sys.modules:
        del sys.modules["_obs"]
    obs = importlib.import_module("_obs")

    # The shim is a context manager and yields None (= no real span).
    with obs.span("test_span", quorum_id="abc", round_num=1) as s:
        assert s is None


def test_obs_span_uses_real_logfire_when_present(monkeypatch: pytest.MonkeyPatch):
    """When logfire is available, _obs.span() delegates to logfire.span()."""
    fake_logfire = _install_fake_logfire(monkeypatch)
    sentinel_span = MagicMock(name="sentinel_span")
    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=sentinel_span)
    cm.__exit__ = MagicMock(return_value=None)
    fake_logfire.span = MagicMock(return_value=cm)

    if "_obs" in sys.modules:
        del sys.modules["_obs"]
    obs = importlib.import_module("_obs")

    with obs.span("test_span", quorum_id="abc", round_num=1) as s:
        assert s is sentinel_span
    fake_logfire.span.assert_called_once_with("test_span", quorum_id="abc", round_num=1)
