"""``mcp_search`` — tag + text search across the agent blackboard tables.

Tool surface
------------
- ``search_messages(quorum_id, query, top_k=10)`` ->
    ``[{message_id, content, score}]``
- ``search_insights(quorum_id, query, top_k=10)`` ->
    ``[{insight_id, content, score}]``
- ``search_documents(quorum_id, query, top_k=10)`` ->
    ``[{document_id, title, score}]``

Tables consulted (schema: ``supabase/migrations/20260314000002_agent_system.sql``):

- ``station_messages(id, content, tags, embedding)``
- ``agent_insights(id, content, tags, embedding)``
- ``agent_documents(id, title, content, tags)`` (no embedding column)

Scoring (current — pgvector wiring deferred)
--------------------------------------------
We score with two cheap signals that work on every backend, including
the local SQLite dev DB:

1. **Tag overlap** — tokenise the query, intersect with the row's
   ``tags`` array, divide by union size (Jaccard, weight 0.6).
2. **Substring match** — count case-insensitive occurrences of each
   query token in the row's content/title, normalised by token count
   (weight 0.4).

When pgvector is wired up (follow-up — checklist 11.4), replace
``_score`` with a cosine-similarity query against ``embedding`` using
the Pydantic AI provider's ``.embed()`` from PR #16.  Tool signatures
do not change.
"""

from __future__ import annotations

import re
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError


# ---------------------------------------------------------------------------
# Scoring helpers — see TODO at top of file.
# ---------------------------------------------------------------------------

_TOKEN_RX = re.compile(r"[A-Za-z0-9_]+")


def _tokenise(text: str) -> list[str]:
    return [t.lower() for t in _TOKEN_RX.findall(text or "") if len(t) > 1]


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 0.0
    return len(a & b) / max(len(a | b), 1)


def _substring_score(query_tokens: list[str], haystack: str) -> float:
    if not query_tokens or not haystack:
        return 0.0
    h = haystack.lower()
    hits = sum(1 for t in query_tokens if t in h)
    return hits / len(query_tokens)


def _score(row: dict[str, Any], query: str, text_fields: tuple[str, ...]) -> float:
    qt = _tokenise(query)
    if not qt:
        return 0.0
    tags = row.get("tags") or []
    if isinstance(tags, str):  # SQLite stores JSON-encoded lists in TEXT
        try:
            import json
            tags = json.loads(tags)
        except (TypeError, ValueError):
            tags = []
    tag_set = {str(t).lower() for t in (tags or [])}
    haystack = " ".join(str(row.get(f) or "") for f in text_fields)
    return 0.6 * _jaccard(set(qt), tag_set) + 0.4 * _substring_score(qt, haystack)


def _rank(
    rows: list[dict[str, Any]],
    query: str,
    text_fields: tuple[str, ...],
    top_k: int,
) -> list[tuple[dict[str, Any], float]]:
    scored = [(r, _score(r, query, text_fields)) for r in rows]
    scored = [pair for pair in scored if pair[1] > 0.0]
    scored.sort(key=lambda p: p[1], reverse=True)
    return scored[: max(top_k, 0)]


def _fetch_quorum_rows(
    db: Any,
    table: str,
    quorum_id: str,
    columns: str = "*",
) -> list[dict[str, Any]]:
    try:
        result = (
            db.table(table)
            .select(columns)
            .eq("quorum_id", quorum_id)
            .execute()
        )
    except Exception as exc:
        raise ToolError(f"{table} query failed: {exc!s}") from exc
    return list(getattr(result, "data", None) or [])


# ---------------------------------------------------------------------------
# Public factory
# ---------------------------------------------------------------------------

def build(db: Any) -> FastMCP:
    """Construct the ``mcp_search`` server bound to ``db``."""
    mcp = FastMCP("mcp_search")

    @mcp.tool()
    def search_messages(
        quorum_id: str,
        query: str,
        top_k: int = 10,
    ) -> list[dict[str, Any]]:
        """Search ``station_messages`` by tags + content for a quorum."""
        if not quorum_id:
            raise ToolError("quorum_id is required")
        rows = _fetch_quorum_rows(
            db, "station_messages", quorum_id, columns="id, content, tags"
        )
        ranked = _rank(rows, query, text_fields=("content",), top_k=top_k)
        return [
            {
                "message_id": r["id"],
                "content": r.get("content") or "",
                "score": round(score, 4),
            }
            for (r, score) in ranked
        ]

    @mcp.tool()
    def search_insights(
        quorum_id: str,
        query: str,
        top_k: int = 10,
    ) -> list[dict[str, Any]]:
        """Search ``agent_insights`` by tags + content for a quorum."""
        if not quorum_id:
            raise ToolError("quorum_id is required")
        rows = _fetch_quorum_rows(
            db, "agent_insights", quorum_id, columns="id, content, tags"
        )
        ranked = _rank(rows, query, text_fields=("content",), top_k=top_k)
        return [
            {
                "insight_id": r["id"],
                "content": r.get("content") or "",
                "score": round(score, 4),
            }
            for (r, score) in ranked
        ]

    @mcp.tool()
    def search_documents(
        quorum_id: str,
        query: str,
        top_k: int = 10,
    ) -> list[dict[str, Any]]:
        """Search ``agent_documents`` by tags + title for a quorum."""
        if not quorum_id:
            raise ToolError("quorum_id is required")
        rows = _fetch_quorum_rows(
            db, "agent_documents", quorum_id, columns="id, title, tags"
        )
        ranked = _rank(rows, query, text_fields=("title",), top_k=top_k)
        return [
            {
                "document_id": r["id"],
                "title": r.get("title") or "",
                "score": round(score, 4),
            }
            for (r, score) in ranked
        ]

    return mcp
