"""``mcp_broadcast`` — MCP server wrapping the WebSocket manager.

Tool surface
------------
- ``broadcast(quorum_id, event_type, payload) -> {ok}``
- ``notify_role(role_id, event_type, payload) -> {ok}``

Notes
-----
``notify_role`` performs a *best-effort* delivery: the existing
``ws_manager.ConnectionManager`` only indexes connections by ``quorum_id``,
not ``role_id``.  Until the WS manager grows a role-keyed registry
(tracked as a follow-up — see TODO in ``apps/api/ws_manager.py``), this
tool walks each connected quorum and broadcasts an envelope that embeds
the target ``role_id`` so clients can filter client-side.  When the
manager is upgraded, replace ``_notify_role`` with the direct
``manager.send_to_role(role_id, ...)`` call.
"""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError


async def _notify_role_shim(ws_manager: Any, role_id: str, frame: dict[str, Any]) -> bool:
    """Fan a role-targeted frame out across all known quorums.

    The frame includes ``target_role_id`` so the client SDK can drop
    frames that don't apply to its current role context.
    """
    delivered = False
    conns = getattr(ws_manager, "_connections", {}) or {}
    # Snapshot keys to avoid mutation during iteration.
    quorum_ids = list(conns.keys())
    for q_id in quorum_ids:
        try:
            await ws_manager.broadcast(q_id, frame)
            delivered = True
        except Exception:  # pragma: no cover — broadcast logs/handles its own errors
            continue
    return delivered


def build(ws_manager: Any) -> FastMCP:
    """Construct the ``mcp_broadcast`` server bound to ``ws_manager``."""
    mcp = FastMCP("mcp_broadcast")

    @mcp.tool()
    async def broadcast(
        quorum_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> dict[str, bool]:
        """Broadcast a frame to every WS client subscribed to ``quorum_id``.

        Returns ``{"ok": True}`` on successful enqueue. The actual send
        is debounced to 1Hz per quorum by ``ws_manager.ConnectionManager``.
        """
        if not (quorum_id and event_type):
            raise ToolError("quorum_id and event_type are required")
        frame = {"type": event_type, **(payload or {})}
        try:
            await ws_manager.broadcast(quorum_id, frame)
        except Exception as exc:
            raise ToolError(f"broadcast failed: {exc!s}") from exc
        return {"ok": True}

    @mcp.tool()
    async def notify_role(
        role_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> dict[str, bool]:
        """Send a frame addressed to a specific role.

        Uses a role-targeted envelope (``target_role_id``) so clients
        can filter; see module docstring for the future direct-routing
        plan.
        """
        if not (role_id and event_type):
            raise ToolError("role_id and event_type are required")
        frame = {
            "type": event_type,
            "target_role_id": role_id,
            **(payload or {}),
        }
        delivered = await _notify_role_shim(ws_manager, role_id, frame)
        return {"ok": delivered}

    return mcp
