"""Tests for budget exhaustion handling."""

import pytest

from quorum_llm.budget import BudgetGuard, guarded_complete
from quorum_llm.interface import LLMProvider
from quorum_llm.models import BudgetExhaustedError, LLMTier


class ExplodingProvider(LLMProvider):
    """Provider that always raises BudgetExhaustedError."""

    async def complete(self, prompt: str, tier: LLMTier) -> str:
        raise BudgetExhaustedError(provider="test", tier=tier, detail="429 Too Many Requests")

    async def embed(self, text: str) -> list[float]:
        raise BudgetExhaustedError(provider="test", tier=LLMTier.CONFLICT, detail="429")


class WorkingProvider(LLMProvider):
    async def complete(self, prompt: str, tier: LLMTier) -> str:
        return "ok"

    async def embed(self, text: str) -> list[float]:
        return [0.0]


@pytest.mark.asyncio
async def test_budget_guard_notifies():
    notifications: list[tuple[str, str]] = []

    async def mock_notify(event_id: str, message: str):
        notifications.append((event_id, message))

    guard = BudgetGuard(notify=mock_notify)
    err = BudgetExhaustedError(provider="azure", tier=LLMTier.SYNTHESIS, detail="429")
    await guard.on_budget_exhausted(err, event_id="evt-1")

    assert len(notifications) == 1
    assert notifications[0][0] == "evt-1"
    assert "azure" in notifications[0][1]
    assert err.event_owner_notified is True


@pytest.mark.asyncio
async def test_budget_guard_no_callback():
    guard = BudgetGuard(notify=None)
    err = BudgetExhaustedError(provider="azure", tier=LLMTier.SYNTHESIS)
    await guard.on_budget_exhausted(err, event_id="evt-1")
    assert not err.event_owner_notified


@pytest.mark.asyncio
async def test_guarded_complete_success():
    result = await guarded_complete(WorkingProvider(), "test", LLMTier.CONFLICT)
    assert result == "ok"


@pytest.mark.asyncio
async def test_guarded_complete_fallback():
    result = await guarded_complete(
        ExplodingProvider(), "test", LLMTier.CONFLICT, fallback="fallback value"
    )
    assert result == "fallback value"


@pytest.mark.asyncio
async def test_guarded_complete_with_guard():
    notifications = []

    async def mock_notify(event_id, message):
        notifications.append((event_id, message))

    guard = BudgetGuard(notify=mock_notify)
    result = await guarded_complete(
        ExplodingProvider(), "test", LLMTier.CONFLICT,
        budget_guard=guard, event_id="evt-1", fallback="safe",
    )
    assert result == "safe"
    assert len(notifications) == 1


@pytest.mark.asyncio
async def test_guarded_complete_raises_without_fallback():
    with pytest.raises(BudgetExhaustedError):
        await guarded_complete(
            ExplodingProvider(), "test", LLMTier.CONFLICT, fallback=None
        )
