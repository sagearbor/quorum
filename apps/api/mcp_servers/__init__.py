"""MCP (Model Context Protocol) servers for Quorum role-agents.

This package exposes Quorum's internal capabilities (blackboard state,
WebSocket broadcasts, authority lookups, tag/embedding search) as MCP
servers so any Pydantic AI agent or other MCP-compliant client can call
them as tools.

Checklist item 11.2 — *Build 4 MCP servers*.

The Python ``mcp`` SDK is pinned in ``apps/api/requirements.txt``
(>=1.12, <2). We use the FastMCP convenience API
(``mcp.server.fastmcp.FastMCP``) which auto-generates input/output JSON
schemas from Python type hints and exposes a public ``call_tool()`` /
``list_tools()`` surface that can be invoked in-process (no stdio
transport required for tests or for tool wiring inside the orchestrator).

Each ``build_*_server`` factory returns a configured ``FastMCP`` instance
that closes over the db / ws_manager dependencies it needs. The
orchestrator (11.3) does *not* wire these as agent tools yet — that is a
follow-up — but the servers are constructed and ready.

Usage
-----

    from apps.api.mcp_servers import build_all_servers
    from apps.api.ws_manager import manager as ws_manager
    from apps.api.database import get_supabase

    servers = build_all_servers(get_supabase(), ws_manager)
    # servers = {"state": FastMCP, "broadcast": FastMCP,
    #            "authority": FastMCP, "search": FastMCP}

Naming note
-----------
The package is intentionally named ``mcp_servers`` (not just ``mcp``)
to avoid shadowing the installed PyPI ``mcp`` SDK on ``sys.path``:
the test conftest inserts ``apps/api`` for bare imports, which would
otherwise route ``import mcp.server.fastmcp`` into this directory.
"""

from __future__ import annotations

from typing import Any

from .authority_server import build as build_authority_server
from .broadcast_server import build as build_broadcast_server
from .search_server import build as build_search_server
from .state_server import build as build_state_server

__all__ = [
    "build_state_server",
    "build_broadcast_server",
    "build_authority_server",
    "build_search_server",
    "build_all_servers",
]


def build_all_servers(db: Any, ws_manager: Any) -> dict[str, Any]:
    """Construct all four Quorum MCP servers in one call.

    Parameters
    ----------
    db
        Anything that quacks like the Supabase client (i.e. exposes
        ``.table(name).select(...).eq(...).execute()``). The repo's
        ``SQLiteClient`` and ``supabase.Client`` both satisfy this.
    ws_manager
        Quorum's ``ws_manager.ConnectionManager`` instance.

    Returns
    -------
    dict[str, FastMCP]
        Keyed by ``"state"``, ``"broadcast"``, ``"authority"``,
        ``"search"``.
    """
    return {
        "state": build_state_server(db),
        "broadcast": build_broadcast_server(ws_manager),
        "authority": build_authority_server(db),
        "search": build_search_server(db),
    }
