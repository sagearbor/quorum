"""Unit tests for the four MCP servers (checklist 11.2).

What these cover:

* Each ``build_*_server`` factory returns a working ``FastMCP`` instance
  and the expected tool surface (no errors at construction time).
* Each tool's *direct* function call returns the documented shape with
  a mocked db / ws_manager.
* Each tool's *MCP* invocation path (``await mcp.call_tool(name, args)``)
  produces an MCP-compliant return — exercising the FastMCP serialiser.
* Error paths (missing required args, unknown role, backend failure)
  raise ``ToolError`` so they cross the protocol boundary as the
  standard MCP ``isError`` envelope rather than as bare exceptions.

We deliberately invoke the *raw* tool function (``mcp._tool_manager
.get_tool(name).fn``) for shape assertions — that returns the native
Python dict before FastMCP wraps it into TextContent — and use the
public ``call_tool`` to confirm the protocol path doesn't blow up.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

# Ensure the MCP SDK is importable; if not, skip the whole module
# (this is the "stop condition" surface — CI must install mcp). We probe
# the deepest submodule we actually use so a partial install of `mcp`
# (e.g., one shipped as a stub by another conftest) doesn't silently
# false-pass the gate.
pytest.importorskip("mcp.server.fastmcp")

from mcp.server.fastmcp.exceptions import ToolError  # noqa: E402

from apps.api.mcp_servers import (  # noqa: E402
    build_all_servers,
    build_authority_server,
    build_broadcast_server,
    build_search_server,
    build_state_server,
)


# ---------------------------------------------------------------------------
# Fake Supabase-style db (matches the .table().select().eq().execute() API)
# ---------------------------------------------------------------------------

class _Result:
    def __init__(self, data: Any) -> None:
        self.data = data


class _FakeQuery:
    """In-memory query builder that supports the subset of operators the
    MCP servers use: select(), eq(), order(), limit(), insert(), execute()."""

    def __init__(self, rows: list[dict[str, Any]], table: str, store: dict) -> None:
        self._rows = list(rows)
        self._table = table
        self._store = store
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None
        self._pending_insert: dict | None = None

    def select(self, _cols: str = "*") -> "_FakeQuery":
        return self

    def eq(self, col: str, val: Any) -> "_FakeQuery":
        self._rows = [r for r in self._rows if r.get(col) == val]
        return self

    def order(self, col: str, desc: bool = False) -> "_FakeQuery":
        self._order = (col, desc)
        return self

    def limit(self, n: int) -> "_FakeQuery":
        self._limit = n
        return self

    def insert(self, data: dict) -> "_FakeQuery":
        self._pending_insert = data
        return self

    def execute(self) -> _Result:
        if self._pending_insert is not None:
            self._store.setdefault(self._table, []).append(self._pending_insert)
            return _Result([self._pending_insert])

        rows = list(self._rows)
        if self._order is not None:
            col, desc = self._order
            rows.sort(key=lambda r: (r.get(col) or 0), reverse=desc)
        if self._limit is not None:
            rows = rows[: self._limit]
        return _Result(rows)


class FakeDB:
    """Minimal in-memory db whose `.table(name)` returns a `_FakeQuery`."""

    def __init__(self) -> None:
        self._store: dict[str, list[dict[str, Any]]] = {}

    def table(self, name: str) -> _FakeQuery:
        return _FakeQuery(self._store.get(name, []), name, self._store)

    # Helpers for test setup
    def seed(self, name: str, rows: list[dict[str, Any]]) -> None:
        self._store[name] = list(rows)


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def db() -> FakeDB:
    fake = FakeDB()
    fake.seed("quorums", [
        {"id": "q1", "title": "Trial Design"},
    ])
    fake.seed("roles", [
        {"id": "r-pi", "quorum_id": "q1", "name": "PI", "authority_rank": 10,
         "capacity": "1", "status": "active"},
        {"id": "r-bs", "quorum_id": "q1", "name": "Biostatistician",
         "authority_rank": 5, "capacity": "1", "status": "active"},
        {"id": "r-ethics", "quorum_id": "q1", "name": "Ethics",
         "authority_rank": 5, "capacity": "unlimited", "status": "active"},
    ])
    fake.seed("contributions", [
        {"id": "c1", "quorum_id": "q1", "role_id": "r-pi",
         "user_token": "u-pi", "content": "Use a 2-arm RCT.",
         "created_at": "2026-05-13T00:00:00Z"},
    ])
    fake.seed("station_messages", [
        {"id": "m1", "quorum_id": "q1", "content": "Sample size needs 200 per arm",
         "tags": ["sample_size", "biostats"]},
        {"id": "m2", "quorum_id": "q1", "content": "Randomization should be blocked",
         "tags": ["randomization", "design"]},
        {"id": "m3", "quorum_id": "other", "content": "Off-quorum noise",
         "tags": ["sample_size"]},
    ])
    fake.seed("agent_insights", [
        {"id": "i1", "quorum_id": "q1",
         "content": "Recommend biostatistician review",
         "tags": ["biostats", "review"]},
    ])
    fake.seed("agent_documents", [
        {"id": "d1", "quorum_id": "q1", "title": "Protocol draft v1",
         "tags": ["protocol", "draft"]},
    ])
    return fake


@pytest.fixture
def ws_manager() -> MagicMock:
    m = MagicMock()
    m.broadcast = AsyncMock(return_value=None)
    m._connections = {"q1": {object(), object()}}
    return m


# ---------------------------------------------------------------------------
# Construction smoke test — checklist item: "Each server starts cleanly"
# ---------------------------------------------------------------------------

def test_build_all_servers_returns_four_named_instances(db, ws_manager):
    servers = build_all_servers(db, ws_manager)
    assert set(servers.keys()) == {"state", "broadcast", "authority", "search"}
    # FastMCP exposes .name
    for key, server in servers.items():
        assert server.name.startswith("mcp_"), f"{key}: bad server name {server.name!r}"


@pytest.mark.asyncio
async def test_each_server_lists_documented_tool_surface(db, ws_manager):
    servers = build_all_servers(db, ws_manager)

    expected = {
        "state": {
            "get_quorum_state", "propose", "support_proposal",
            "block_proposal", "raise_question",
        },
        "broadcast": {"broadcast", "notify_role"},
        "authority": {
            "get_role_authority", "list_roles_by_quorum", "compare_authority",
        },
        "search": {"search_messages", "search_insights", "search_documents"},
    }

    for key, server in servers.items():
        tools = await server.list_tools()
        names = {t.name for t in tools}
        assert names == expected[key], (
            f"{key} tool surface mismatch: got {names}, want {expected[key]}"
        )


# ---------------------------------------------------------------------------
# mcp_authority
# ---------------------------------------------------------------------------

def _raw(server, tool_name):
    """Return the raw Python function behind a FastMCP-registered tool."""
    return server._tool_manager.get_tool(tool_name).fn


def test_authority_get_role_authority_returns_shape(db):
    server = build_authority_server(db)
    out = _raw(server, "get_role_authority")("r-pi")
    assert out == {"authority_rank": 10, "name": "PI"}


def test_authority_get_role_authority_missing_role_raises_toolerror(db):
    server = build_authority_server(db)
    with pytest.raises(ToolError):
        _raw(server, "get_role_authority")("does-not-exist")


def test_authority_list_roles_by_quorum_sorted_desc(db):
    server = build_authority_server(db)
    rows = _raw(server, "list_roles_by_quorum")("q1")
    assert [r["role_id"] for r in rows] == ["r-pi", "r-bs", "r-ethics"]
    pi = rows[0]
    assert pi == {
        "role_id": "r-pi", "name": "PI", "authority_rank": 10,
        "capacity": "1", "status": "active",
    }


def test_authority_compare_authority_all_three_outcomes(db):
    server = build_authority_server(db)
    fn = _raw(server, "compare_authority")
    assert fn("r-pi", "r-bs") == "a"
    assert fn("r-bs", "r-pi") == "b"
    assert fn("r-bs", "r-ethics") == "tie"


def test_authority_compare_authority_missing_required_args(db):
    server = build_authority_server(db)
    with pytest.raises(ToolError):
        _raw(server, "compare_authority")("", "r-pi")


def _extract_structured(result: Any) -> Any:
    """Normalize a FastMCP ``call_tool`` return into a plain dict/list.

    Depending on whether the tool has an inferred output schema FastMCP
    returns either:

    * ``list[ContentBlock]`` — text blocks only, parse the JSON inside.
    * ``tuple[list[ContentBlock], dict]`` — content + structured data.
    * ``dict`` — direct dict return.
    """
    if isinstance(result, tuple) and len(result) == 2:
        # (content_blocks, structured_data)
        return result[1]
    if isinstance(result, list):
        # First TextContent block holds the JSON-encoded payload.
        return json.loads(result[0].text)
    return result


@pytest.mark.asyncio
async def test_authority_call_tool_protocol_path(db):
    """The public MCP path must not raise and must produce a non-empty result."""
    server = build_authority_server(db)
    result = await server.call_tool("get_role_authority", {"role_id": "r-pi"})
    parsed = _extract_structured(result)
    assert parsed["authority_rank"] == 10
    assert parsed["name"] == "PI"


# ---------------------------------------------------------------------------
# mcp_search
# ---------------------------------------------------------------------------

def test_search_messages_tag_match_ranks_correctly(db):
    server = build_search_server(db)
    out = _raw(server, "search_messages")("q1", "sample_size", top_k=5)
    # m1 has tag sample_size — should appear, m3 is filtered by quorum_id.
    assert any(r["message_id"] == "m1" for r in out)
    assert not any(r["message_id"] == "m3" for r in out)
    # score should be > 0 and rounded.
    assert out[0]["score"] > 0.0


def test_search_messages_returns_empty_when_no_match(db):
    server = build_search_server(db)
    out = _raw(server, "search_messages")("q1", "completely_unrelated_xyzzy", top_k=5)
    assert out == []


def test_search_insights_shape(db):
    server = build_search_server(db)
    out = _raw(server, "search_insights")("q1", "biostats", top_k=5)
    assert out
    row = out[0]
    assert set(row.keys()) == {"insight_id", "content", "score"}


def test_search_documents_shape(db):
    server = build_search_server(db)
    out = _raw(server, "search_documents")("q1", "protocol", top_k=5)
    assert out
    assert out[0]["document_id"] == "d1"
    assert "title" in out[0] and "score" in out[0]


def test_search_missing_quorum_id_raises_toolerror(db):
    server = build_search_server(db)
    with pytest.raises(ToolError):
        _raw(server, "search_messages")("", "anything")


def test_search_top_k_caps_results(db):
    server = build_search_server(db)
    # Seed extra rows so we can test top_k truncation deterministically.
    db.seed("station_messages", [
        {"id": f"m-{i}", "quorum_id": "q1", "content": "sample size matters",
         "tags": ["sample_size"]}
        for i in range(20)
    ])
    out = _raw(server, "search_messages")("q1", "sample_size", top_k=3)
    assert len(out) == 3


# ---------------------------------------------------------------------------
# mcp_broadcast
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_broadcast_invokes_ws_manager_broadcast(ws_manager):
    server = build_broadcast_server(ws_manager)
    fn = _raw(server, "broadcast")
    out = await fn("q1", "test_event", {"hello": "world"})
    assert out == {"ok": True}
    ws_manager.broadcast.assert_awaited_once()
    args = ws_manager.broadcast.await_args.args
    assert args[0] == "q1"
    assert args[1]["type"] == "test_event"
    assert args[1]["hello"] == "world"


@pytest.mark.asyncio
async def test_broadcast_missing_required_args_raises_toolerror(ws_manager):
    server = build_broadcast_server(ws_manager)
    with pytest.raises(ToolError):
        await _raw(server, "broadcast")("", "evt", {})


@pytest.mark.asyncio
async def test_broadcast_wrapps_backend_failure_as_toolerror(ws_manager):
    ws_manager.broadcast = AsyncMock(side_effect=RuntimeError("ws down"))
    server = build_broadcast_server(ws_manager)
    with pytest.raises(ToolError) as excinfo:
        await _raw(server, "broadcast")("q1", "evt", {})
    assert "ws down" in str(excinfo.value)


@pytest.mark.asyncio
async def test_notify_role_fans_out_across_known_quorums(ws_manager):
    server = build_broadcast_server(ws_manager)
    out = await _raw(server, "notify_role")("r-pi", "agent_thought", {"text": "hi"})
    assert out == {"ok": True}
    ws_manager.broadcast.assert_awaited()
    frame = ws_manager.broadcast.await_args.args[1]
    assert frame["target_role_id"] == "r-pi"
    assert frame["type"] == "agent_thought"


# ---------------------------------------------------------------------------
# mcp_state
# ---------------------------------------------------------------------------

def test_state_get_quorum_state_synthesises_when_no_snapshot(db):
    server = build_state_server(db)
    out = _raw(server, "get_quorum_state")("q1")
    assert out["quorum_id"] == "q1"
    assert out["quorum"]["title"] == "Trial Design"
    assert len(out["roles"]) == 3
    assert len(out["contributions"]) == 1
    assert out["_shim"] == "11.6-pending"


def test_state_get_quorum_state_unknown_quorum_raises_toolerror(db):
    server = build_state_server(db)
    with pytest.raises(ToolError):
        _raw(server, "get_quorum_state")("nope")


def test_state_propose_returns_uuid_and_writes_envelope(db):
    server = build_state_server(db)
    out = _raw(server, "propose")(
        "q1", "endpoints", "PFS at 18 months", "r-pi",
    )
    assert "proposal_id" in out
    pid = out["proposal_id"]
    # 36-char UUID
    assert len(pid) == 36 and pid.count("-") == 4

    # Envelope written
    rows = db.table("quorum_state_snapshots").select("*").execute().data
    assert rows, "expected envelope write"
    envelope = rows[-1]["snapshot"]
    assert envelope["kind"] == "proposal"
    assert envelope["body"]["field"] == "endpoints"
    assert envelope["body"]["proposed_by_role_id"] == "r-pi"
    assert envelope["__shim__"] == "11.6-pending"


def test_state_propose_missing_args_raises_toolerror(db):
    server = build_state_server(db)
    with pytest.raises(ToolError):
        _raw(server, "propose")("q1", "", "x", "r-pi")


def test_state_support_and_block_proposal_write_envelopes(db):
    server = build_state_server(db)
    s_out = _raw(server, "support_proposal")("q1", "p-1", "r-pi")
    b_out = _raw(server, "block_proposal")("q1", "p-1", "r-ethics")
    assert s_out == {"ok": True}
    assert b_out == {"ok": True}

    rows = db.table("quorum_state_snapshots").select("*").execute().data
    kinds = [r["snapshot"]["kind"] for r in rows]
    assert "proposal_support" in kinds
    assert "proposal_block" in kinds


def test_state_raise_question_returns_uuid(db):
    server = build_state_server(db)
    out = _raw(server, "raise_question")(
        "q1", "What is the primary endpoint?", "r-pi", ["endpoint", "design"],
    )
    assert "question_id" in out
    rows = db.table("quorum_state_snapshots").select("*").execute().data
    last = rows[-1]["snapshot"]
    assert last["kind"] == "question"
    assert last["body"]["tags"] == ["endpoint", "design"]


def test_state_raise_question_tags_default_to_empty_list(db):
    server = build_state_server(db)
    _raw(server, "raise_question")("q1", "Why?", "r-pi", None)
    rows = db.table("quorum_state_snapshots").select("*").execute().data
    last = rows[-1]["snapshot"]
    assert last["body"]["tags"] == []


# ---------------------------------------------------------------------------
# End-to-end protocol smoke — verifies FastMCP -> CallToolResult path
# works for at least one tool per server (catches contract regressions in
# the SDK wrapper rather than in our business logic).
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_protocol_call_tool_paths_for_all_servers(db, ws_manager):
    servers = build_all_servers(db, ws_manager)

    # state
    await servers["state"].call_tool("get_quorum_state", {"quorum_id": "q1"})

    # broadcast
    await servers["broadcast"].call_tool(
        "broadcast",
        {"quorum_id": "q1", "event_type": "ping", "payload": {}},
    )

    # authority
    await servers["authority"].call_tool(
        "list_roles_by_quorum", {"quorum_id": "q1"},
    )

    # search
    await servers["search"].call_tool(
        "search_messages",
        {"quorum_id": "q1", "query": "sample_size", "top_k": 5},
    )
