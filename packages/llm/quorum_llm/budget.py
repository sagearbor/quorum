"""Graceful error handling for API budget exhaustion.

Per DECISIONS.md: no upfront rate limiting. Catch on exhaustion, notify event owner.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Awaitable, Callable

from quorum_llm.models import BudgetExhaustedError

logger = logging.getLogger(__name__)

# Type alias for the notification callback
NotifyCallback = Callable[[str, str], Awaitable[None]]


@dataclass
class BudgetGuard:
    """Wraps LLM calls with budget exhaustion handling.

    On BudgetExhaustedError, logs the event and calls the notification
    callback so the event owner is informed.
    """

    notify: NotifyCallback | None = None

    async def on_budget_exhausted(
        self,
        error: BudgetExhaustedError,
        event_id: str | None = None,
    ) -> None:
        """Handle a budget exhaustion error.

        Logs the error and notifies the event owner if a callback is configured.
        """
        logger.error(
            "LLM budget exhausted: provider=%s tier=%s detail=%s",
            error.provider,
            error.tier.name,
            error.detail,
        )

        if self.notify and event_id:
            message = (
                f"LLM API budget exhausted for provider '{error.provider}' "
                f"at tier {error.tier.name}. "
                "Synthesis operations are temporarily unavailable. "
                "Please check your API quota."
            )
            try:
                await self.notify(event_id, message)
                error.event_owner_notified = True
            except Exception:
                logger.exception("Failed to notify event owner for event %s", event_id)

        error.event_owner_notified = error.event_owner_notified or False


async def guarded_complete(
    provider,
    prompt: str,
    tier,
    budget_guard: BudgetGuard | None = None,
    event_id: str | None = None,
    fallback: str = "",
) -> str:
    """Execute a completion with budget exhaustion handling.

    Returns fallback string if budget is exhausted and caller provided one.
    Re-raises BudgetExhaustedError after notification if no fallback.
    """
    try:
        return await provider.complete(prompt, tier)
    except BudgetExhaustedError as exc:
        if budget_guard:
            await budget_guard.on_budget_exhausted(exc, event_id)
        if fallback is not None:
            return fallback
        raise
