"""``mcp_authority`` — MCP server for role/authority lookups.

Tool surface
------------
- ``get_role_authority(role_id) -> {authority_rank, name}``
- ``list_roles_by_quorum(quorum_id) -> [{role_id, name, authority_rank,
                                          capacity, status}]``
- ``compare_authority(role_a_id, role_b_id) -> "a" | "b" | "tie"``

Schema source: ``supabase/migrations/20260225000001_initial_schema.sql``
(``roles`` table; columns ``id, quorum_id, name, capacity,
authority_rank``).  ``status`` is added by a later migration; if absent
we default to ``"active"``.
"""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError


def build(db: Any) -> FastMCP:
    """Construct the ``mcp_authority`` server bound to ``db``."""
    mcp = FastMCP("mcp_authority")

    @mcp.tool()
    def get_role_authority(role_id: str) -> dict[str, Any]:
        """Return ``{authority_rank, name}`` for a single role.

        Raises a ``ToolError`` if the role does not exist.
        """
        if not role_id:
            raise ToolError("role_id is required")
        try:
            result = (
                db.table("roles")
                .select("id, name, authority_rank")
                .eq("id", role_id)
                .execute()
            )
        except Exception as exc:
            raise ToolError(f"role lookup failed: {exc!s}") from exc

        rows = getattr(result, "data", None) or []
        if not rows:
            raise ToolError(f"role {role_id!r} not found")
        row = rows[0]
        return {
            "authority_rank": int(row.get("authority_rank") or 0),
            "name": row.get("name") or "",
        }

    @mcp.tool()
    def list_roles_by_quorum(quorum_id: str) -> list[dict[str, Any]]:
        """List all roles for a quorum, ordered by authority (desc)."""
        if not quorum_id:
            raise ToolError("quorum_id is required")
        try:
            result = (
                db.table("roles")
                .select("*")
                .eq("quorum_id", quorum_id)
                .order("authority_rank", desc=True)
                .execute()
            )
        except Exception as exc:
            raise ToolError(f"roles query failed: {exc!s}") from exc

        rows = getattr(result, "data", None) or []
        return [
            {
                "role_id": r["id"],
                "name": r.get("name") or "",
                "authority_rank": int(r.get("authority_rank") or 0),
                "capacity": r.get("capacity") or "unlimited",
                "status": r.get("status") or "active",
            }
            for r in rows
        ]

    @mcp.tool()
    def compare_authority(role_a_id: str, role_b_id: str) -> str:
        """Compare two roles' ``authority_rank``.

        Returns ``"a"`` if A outranks B, ``"b"`` if B outranks A,
        or ``"tie"`` when equal.  Either role missing -> ``ToolError``.
        """
        if not (role_a_id and role_b_id):
            raise ToolError("both role_a_id and role_b_id are required")

        a = get_role_authority(role_a_id)
        b = get_role_authority(role_b_id)
        ra, rb = a["authority_rank"], b["authority_rank"]
        if ra > rb:
            return "a"
        if rb > ra:
            return "b"
        return "tie"

    return mcp
