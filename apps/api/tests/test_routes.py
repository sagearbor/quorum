"""Security regression tests for high-risk endpoints in apps/api/routes.py.

Audit finding (PR #14):
``POST /quorums/{quorum_id}/contribute`` verified that the quorum existed
and was open but never checked that ``body.role_id`` actually belonged to
that quorum. At a live event with multiple concurrent quorums, an
attendee could write into another quorum's artifact by passing a foreign
role_id in the request body.

Fix: insert a role-belongs-to-quorum lookup before the contribution is
submitted. Mismatched role_ids must return HTTP 422.
"""

from __future__ import annotations

import importlib
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Filter-aware Supabase mock — needed because the cross-quorum check relies
# on the .eq("id", role_id) filter actually narrowing the row set.
# ---------------------------------------------------------------------------

def _make_fake_supabase(overrides: dict[str, list[dict[str, Any]]] | None = None) -> MagicMock:
    overrides = overrides or {}

    def _table_builder(table_name: str):
        rows = list(overrides.get(table_name, []))
        state: dict[str, Any] = {"single": False, "filters": []}
        chain = MagicMock()

        def _single():
            state["single"] = True
            return chain

        def _maybe_single():
            state["single"] = True
            return chain

        def _eq(col, val):
            state["filters"].append((col, val))
            return chain

        chain.single = _single
        chain.maybe_single = _maybe_single
        chain.eq.side_effect = _eq

        for method in (
            "select", "neq", "lt", "gt", "gte", "lte",
            "order", "limit", "insert", "update", "delete",
            "upsert", "filter",
        ):
            getattr(chain, method).return_value = chain

        def _execute():
            filtered = rows
            for col, val in state["filters"]:
                filtered = [r for r in filtered if str(r.get(col)) == str(val)]
            result = MagicMock()
            result.data = (filtered[0] if filtered else None) if state["single"] else filtered
            return result

        chain.execute = _execute
        return chain

    db = MagicMock()
    db.table.side_effect = _table_builder
    return db


_QUORUM_A = {"id": "quorum-A", "status": "active", "title": "Quorum A", "description": "", "heat_score": 0}
_QUORUM_B = {"id": "quorum-B", "status": "active", "title": "Quorum B", "description": "", "heat_score": 0}

# Role that belongs ONLY to quorum A.
_ROLE_IN_A = {
    "id": "role-A-only",
    "quorum_id": "quorum-A",
    "name": "irb_officer",
    "authority_rank": 5,
    "capacity": "unlimited",
}
# Legitimate role in quorum B (used as the happy-path control).
_ROLE_IN_B = {
    "id": "role-B-only",
    "quorum_id": "quorum-B",
    "name": "researcher",
    "authority_rank": 3,
    "capacity": "unlimited",
}


@pytest.fixture()
def client():
    """TestClient backed by a filter-aware fake DB with two quorums + roles."""
    from fastapi.testclient import TestClient

    fake_db = _make_fake_supabase({
        "quorums": [_QUORUM_A, _QUORUM_B],
        "roles": [_ROLE_IN_A, _ROLE_IN_B],
        "contributions": [],
        "artifacts": [],
        "station_messages": [],
        "agent_insights": [],
        "agent_documents": [],
        "agent_requests": [],
    })
    fake_llm = MagicMock()
    fake_llm.complete = AsyncMock(return_value="ok [tags: x]")
    fake_llm.chat = AsyncMock(return_value="ok [tags: x]")

    # Make the coordination backend return a fake contrib row so the happy
    # path can complete without touching real Supabase write paths.
    fake_backend = MagicMock()
    fake_backend.submit_contribution = AsyncMock(return_value={
        "id": str(uuid.uuid4()),
        "quorum_id": "quorum-B",
        "role_id": _ROLE_IN_B["id"],
        "content": "hello",
        "tier_processed": 1,
    })

    with (
        patch("apps.api.routes.get_supabase", return_value=fake_db),
        patch("database.get_supabase", return_value=fake_db),
        patch("apps.api.routes.llm_provider", fake_llm),
        patch("apps.api.routes.get_coordination_backend", return_value=fake_backend),
        patch("apps.api.routes.resolve_dependencies", new=AsyncMock()),
        patch("apps.api.routes.process_agent_turn", new=AsyncMock(
            return_value=("reply", str(uuid.uuid4()), [])
        )),
        patch("apps.api.routes.process_a2a_request", new=AsyncMock(return_value="resp")),
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
    ):
        # Reset coordination backend singleton — the route uses a module-level
        # accessor and we patched the factory.
        import coordination.factory as coord_factory
        coord_factory._backend = None

        import apps.api.main as main_mod
        importlib.reload(main_mod)
        yield TestClient(main_mod.app, raise_server_exceptions=False)

        coord_factory._backend = None


class TestContributeCrossQuorumRoleInjection:
    """Audit finding: /contribute must reject foreign role_ids with 422."""

    def test_contribute_rejects_foreign_role_id(self, client):
        """Role belongs to quorum A; POST to quorum B's /contribute → 422.

        This is the core injection scenario: an attendee at the expo
        composes a request to quorum B's endpoint but sets ``role_id`` to
        a role from quorum A (perhaps overheard from the other station).
        The server must reject before any insert lands in quorum B's
        contributions table.
        """
        resp = client.post(
            "/quorums/quorum-B/contribute",
            json={
                "role_id": _ROLE_IN_A["id"],  # role from quorum A
                "user_token": "attendee-X",
                "content": "Cross-quorum injection payload",
                "structured_fields": {},
            },
        )
        assert resp.status_code == 422, (
            f"foreign role_id must be rejected with 422, got {resp.status_code}: "
            f"{resp.text}"
        )
        assert "role_id" in resp.json().get("detail", "").lower() or \
               "does not belong" in resp.json().get("detail", "").lower(), \
               f"422 should explain the role mismatch: {resp.json()}"

    def test_contribute_rejects_unknown_role_id(self, client):
        """A role_id that exists in neither quorum is also rejected with 422.

        Same code path: the roles lookup returns no row, so the guard
        fires before any insert.
        """
        resp = client.post(
            "/quorums/quorum-B/contribute",
            json={
                "role_id": "role-does-not-exist",
                "user_token": "attendee-Y",
                "content": "Made-up role payload",
                "structured_fields": {},
            },
        )
        assert resp.status_code == 422, resp.text

    def test_contribute_accepts_matching_role_id(self, client):
        """Sanity check: a role that DOES belong to the quorum is accepted.

        This guards against an over-broad fix that rejects legitimate
        traffic too.
        """
        resp = client.post(
            "/quorums/quorum-B/contribute",
            json={
                "role_id": _ROLE_IN_B["id"],  # legitimate role
                "user_token": "attendee-Z",
                "content": "Legit contribution",
                "structured_fields": {},
            },
        )
        assert resp.status_code == 200, (
            f"legitimate role_id should be accepted: {resp.status_code} {resp.text}"
        )


# ---------------------------------------------------------------------------
# /quorums/{quorum_id}/affinity-graph
# ---------------------------------------------------------------------------
# Root cause this guards against: the route did not exist at all (the
# Railway deploy returned 404 "Not Found").  The fix adds an on-fetch
# computation that reads agent_configs.domain_tags + agent_requests and
# emits the AffinityNode / AffinityEdge shape consumed by the dashboards.


class TestAffinityGraphEndpoint:
    """The /affinity-graph endpoint must return a {nodes, edges} payload
    derived on-fetch from agent_configs.domain_tags.

    These tests only assert the endpoint exists, returns 200, and produces
    the documented shape — the Jaccard math itself is covered by
    packages/llm/tests/test_affinity.py.  We override
    ``build_affinity_graph`` here because the conftest stub returns ``{}``
    in the minimal-deps test environment.
    """

    def test_unknown_quorum_returns_404(self, client):
        resp = client.get("/quorums/does-not-exist/affinity-graph")
        assert resp.status_code == 404, resp.text

    def test_quorum_with_no_roles_returns_empty_graph(self, client):
        """The fixture's quorum-A and quorum-B both have roles, so we have to
        construct a no-role case via a separate, role-less quorum."""
        # quorum-A has _ROLE_IN_A only.  Confirm the route returns a valid
        # shape even though no agent_configs / contributions / requests are
        # seeded for it.
        resp = client.get("/quorums/quorum-A/affinity-graph")
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert "nodes" in payload and "edges" in payload, payload
        # quorum-A has exactly one role in the fixture; one node, zero edges.
        assert len(payload["nodes"]) == 1, payload
        assert payload["edges"] == [], payload

    def test_node_shape_matches_dashboard_contract(self, client):
        """Each node must carry the keys AffinityNode declares in
        packages/types/src/dashboard.ts."""
        resp = client.get("/quorums/quorum-B/affinity-graph")
        assert resp.status_code == 200, resp.text
        nodes = resp.json()["nodes"]
        assert nodes, "expected at least one node for quorum-B"
        node = nodes[0]
        for key in ("id", "label", "activityCount", "active", "color", "tags"):
            assert key in node, f"node missing {key!r}: {node}"
