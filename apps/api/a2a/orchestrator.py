"""A2A orchestrator — coordinates multi-agent workflows.

Manages the lifecycle of A2A interactions: dispatching tasks to
role agents, collecting results, and feeding them back into synthesis.
"""

from __future__ import annotations

import logging
from typing import Any

from .a2a_client import A2AClient

logger = logging.getLogger(__name__)


class A2AOrchestrator:
    """Coordinates A2A message flows for a quorum."""

    def __init__(self) -> None:
        self.client = A2AClient()

    async def broadcast_to_roles(
        self, quorum_id: str, role_ids: list[str], message: dict[str, Any],
    ) -> dict[str, Any]:
        """Send a message to all specified roles.

        Returns a summary of delivery results.
        """
        results: dict[str, Any] = {}
        for role_id in role_ids:
            try:
                resp = await self.client.send_message(role_id, {
                    **message,
                    "quorum_id": quorum_id,
                })
                results[role_id] = resp or {"status": "no_endpoint"}
            except Exception:
                logger.warning("A2A broadcast failed for role %s", role_id, exc_info=True)
                results[role_id] = {"status": "error"}
        return results

    async def request_contributions(
        self, quorum_id: str, role_ids: list[str], prompt: str,
    ) -> dict[str, Any]:
        """Request contributions from a set of roles."""
        return await self.broadcast_to_roles(
            quorum_id,
            role_ids,
            {"type": "request_contribution", "prompt": prompt},
        )
