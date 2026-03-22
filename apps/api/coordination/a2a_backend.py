"""A2A protocol implementation of CoordinationBackend.

Routes contributions through A2A agent-to-agent messages,
falling back to Supabase for persistence.
"""

from __future__ import annotations

import logging
from typing import Any

from .supabase_backend import SupabaseBackend

logger = logging.getLogger(__name__)


class A2ABackend(SupabaseBackend):
    """A2A coordination — extends Supabase with agent-to-agent messaging.

    Inherits Supabase persistence; adds A2A message dispatch on top.
    """

    def __init__(self) -> None:
        super().__init__()
        # Lazy import to avoid circular deps
        from ..a2a.a2a_client import A2AClient
        self._a2a_client = A2AClient()

    async def submit_contribution(
        self, quorum_id: str, role_id: str, user_token: str,
        content: str, structured_fields: dict[str, str],
    ) -> dict[str, Any]:
        # Persist via Supabase first
        row = await super().submit_contribution(
            quorum_id, role_id, user_token, content, structured_fields,
        )

        # Then notify via A2A
        try:
            await self._a2a_client.send_message(
                target_role_id=role_id,
                message={
                    "type": "contribution",
                    "quorum_id": quorum_id,
                    "contribution_id": row["id"],
                    "content": content,
                },
            )
        except Exception:
            logger.warning(
                "A2A dispatch failed for contribution %s — persisted in Supabase",
                row["id"],
                exc_info=True,
            )

        return row
