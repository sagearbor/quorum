"""A2A client for sending messages to agent endpoints."""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

# Registry of known agent endpoints: role_id -> URL
_agent_registry: dict[str, str] = {}


class A2AClient:
    """Client for dispatching A2A messages to agent endpoints."""

    def __init__(self) -> None:
        self.base_url = os.environ.get("A2A_BASE_URL", "")

    def register_agent(self, role_id: str, endpoint_url: str) -> None:
        """Register an agent endpoint for a role."""
        _agent_registry[role_id] = endpoint_url

    def get_agent_url(self, role_id: str) -> str | None:
        """Look up the registered endpoint for a role."""
        return _agent_registry.get(role_id)

    async def send_message(
        self, target_role_id: str, message: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Send an A2A message to the agent for target_role_id.

        Returns the response dict if the agent is reachable, None otherwise.
        """
        url = self.get_agent_url(target_role_id)
        if not url:
            logger.debug("No A2A endpoint registered for role %s", target_role_id)
            return None

        # In production this would be an HTTP POST to the agent endpoint.
        # For now, log and return a placeholder.
        logger.info("A2A send to %s: %s", url, message.get("type", "unknown"))
        return {"status": "sent", "target": url}
