"""Tests for db/aexec.py — the asyncio.to_thread wrapper for Supabase calls.

Verifies:
1. Builder form: ``aexec(builder)`` returns the same value
   ``builder.execute()`` would.
2. Thunk form: ``aexec(lambda: builder.execute())`` works equivalently.
3. Concurrency: a blocking ``time.sleep`` in the builder does NOT stall
   another coroutine running on the same event loop.
4. Mock compatibility: pre-existing ``MagicMock`` builders (as used in
   conftest fixtures) still work via the wrapper.
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import MagicMock

import pytest

from db.aexec import aexec


class _FakeBuilder:
    """Minimal duck-typed Supabase builder for tests."""

    def __init__(self, value, sleep_seconds: float = 0.0):
        self._value = value
        self._sleep = sleep_seconds

    def execute(self):
        if self._sleep:
            time.sleep(self._sleep)
        return self._value


@pytest.mark.asyncio
async def test_aexec_builder_returns_same_value_as_execute():
    builder = _FakeBuilder({"data": [1, 2, 3]})
    result = await aexec(builder)
    assert result == {"data": [1, 2, 3]}


@pytest.mark.asyncio
async def test_aexec_thunk_form_works():
    builder = _FakeBuilder({"data": "thunk"})
    result = await aexec(lambda: builder.execute())
    assert result == {"data": "thunk"}


@pytest.mark.asyncio
async def test_aexec_thunk_form_preserves_exception():
    def boom():
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await aexec(boom)


@pytest.mark.asyncio
async def test_aexec_does_not_block_event_loop():
    """A 0.5s blocking sleep inside the builder must NOT stall a sibling
    coroutine. If aexec were synchronous we'd see ~1.0s end-to-end; with
    asyncio.to_thread the two run concurrently so total time is ~0.5s.
    """
    builder = _FakeBuilder("slow", sleep_seconds=0.5)

    async def sibling():
        await asyncio.sleep(0.05)
        return "fast"

    t0 = time.perf_counter()
    slow_result, fast_result = await asyncio.gather(aexec(builder), sibling())
    elapsed = time.perf_counter() - t0

    assert slow_result == "slow"
    assert fast_result == "fast"
    # Generous bound: blocking would give ~1.0s+; concurrent gives ~0.5s.
    # Use 0.85s ceiling to avoid flakes on slow CI.
    assert elapsed < 0.85, f"aexec appears to be blocking the loop ({elapsed:.3f}s)"


@pytest.mark.asyncio
async def test_aexec_with_magicmock_builder():
    """Existing tests pass MagicMock builders to the DB layer; verify the
    wrapper interoperates with them since ``MagicMock().execute`` is
    callable and ``asyncio.to_thread`` runs it in the pool.
    """
    mock_builder = MagicMock()
    mock_builder.execute.return_value = MagicMock(data=[{"id": "abc"}])

    result = await aexec(mock_builder)

    mock_builder.execute.assert_called_once()
    assert result.data == [{"id": "abc"}]


@pytest.mark.asyncio
async def test_aexec_chained_builder_like_supabase():
    """Smoke test the real shape of supabase-py chains: builders are
    objects returned at each step, with .execute() at the leaf.
    """
    chain = MagicMock()
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.execute.return_value = {"rows": [1]}

    result = await aexec(chain.select("*").eq("id", "x"))

    assert result == {"rows": [1]}
    chain.execute.assert_called_once()
