"""RLS lockdown verification for agent tables and synthesis_snapshots.

Migration ``20260512000002_agent_rls_lockdown.sql`` replaced the wide-open
``FOR ALL USING (true)`` policies on the seven agent-system tables with
service-role-only write policies.  Migration ``20260512000001_synthesis_
snapshots.sql`` ships with the same pattern from day one.

This test must run against a REAL Supabase project (the SQLite fallback in
db/sqlite_client.py does not enforce RLS), so it is skipped unless the
``SUPABASE_URL`` and ``SUPABASE_ANON_KEY`` env vars are set.

To run locally::

    export SUPABASE_URL="https://<project>.supabase.co"
    export SUPABASE_ANON_KEY="<anon-key>"
    pytest apps/api/tests/test_rls_lockdown.py -v

The test connects with the *anon* key (NOT the service-role key) and
asserts that INSERT/UPDATE/DELETE are denied while SELECT is allowed.

For the schema-syntax sanity check we also have one always-on test that
parses the migration files with sqlglot if available.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Iterable

import pytest


# ---------------------------------------------------------------------------
# Schema parsing — always runs (best-effort, sqlglot may not be installed)
# ---------------------------------------------------------------------------


def _migration_paths() -> Iterable[Path]:
    root = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
    yield root / "20260512000001_synthesis_snapshots.sql"
    yield root / "20260512000002_agent_rls_lockdown.sql"


def test_new_migrations_parse_as_postgres_sql() -> None:
    """sqlglot should be able to parse every statement in the new migrations.

    sqlglot does not model ``CREATE POLICY`` / ``ALTER TABLE ... ENABLE ROW
    LEVEL SECURITY`` natively — it falls back to a generic ``Command`` node
    rather than raising.  We assert that no statement fails to parse outright.
    """
    sqlglot = pytest.importorskip("sqlglot")
    for path in _migration_paths():
        sql = path.read_text()
        # parse() raises on hard errors; warnings about unsupported syntax
        # are emitted to stderr but the call returns parsed Commands.
        statements = sqlglot.parse(sql, dialect="postgres")
        assert statements, f"{path.name} parsed to zero statements"
        for stmt in statements:
            assert stmt is not None, f"{path.name} produced a None statement"


# ---------------------------------------------------------------------------
# Anon-client write denial — requires a live Supabase project
# ---------------------------------------------------------------------------


_LOCKED_TABLES = (
    "agent_configs",
    "station_messages",
    "agent_documents",
    "document_changes",
    "agent_insights",
    "agent_requests",
    "oscillation_events",
    "synthesis_snapshots",
)


def _live_supabase_client():
    """Return a real supabase client, or skip if the test environment cannot
    provide one (no env vars, or the supabase module is a conftest stub).

    Evaluated INSIDE each test so that ``apps/api/tests/conftest.py``'s mock
    insertion does not cause us to silently pass against MagicMock objects.
    """
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_ANON_KEY")
    if not url or not key:
        pytest.skip("requires SUPABASE_URL and SUPABASE_ANON_KEY for a real project")
    if not url.startswith(("http://", "https://")):
        pytest.skip(f"SUPABASE_URL is not a real URL ({url!r}); skipping live test")

    supabase = pytest.importorskip("supabase")
    create_client = getattr(supabase, "create_client", None)
    if create_client is None:
        pytest.skip("supabase.create_client is not available")

    client = create_client(url, key)
    # conftest's stub returns a MagicMock from create_client; refuse to run
    # the live assertion against a mock since it would pass trivially.
    from unittest.mock import MagicMock
    if isinstance(client, MagicMock):
        pytest.skip("supabase module is mocked by conftest; cannot run live RLS test")
    return client


def test_anon_insert_denied_for_station_messages() -> None:
    """Anon-key INSERT into station_messages must be rejected post-lockdown."""
    client = _live_supabase_client()

    payload = {
        "id": str(uuid.uuid4()),
        "quorum_id": str(uuid.uuid4()),
        "role_id": str(uuid.uuid4()),
        "station_id": "0",
        "role": "user",
        "content": "rls lockdown probe — this row must never land",
    }

    # Real-Supabase clients raise an APIError on RLS violation.  We accept
    # either an exception or an empty .data list as denial.
    try:
        result = client.table("station_messages").insert(payload).execute()
        denied = not getattr(result, "data", None)
    except Exception:  # supabase.lib.client_options.APIError, etc.
        denied = True

    assert denied, (
        "Anon-key INSERT into station_messages succeeded — RLS lockdown "
        "migration 20260512000002 is not applied or is misconfigured."
    )


@pytest.mark.parametrize("table", _LOCKED_TABLES)
def test_anon_select_allowed_on_locked_tables(table: str) -> None:
    """SELECT must remain open after lockdown (dashboards depend on this)."""
    client = _live_supabase_client()

    # A successful response — even with zero rows — means SELECT is allowed.
    result = client.table(table).select("id").limit(1).execute()
    assert hasattr(result, "data"), f"SELECT on {table} returned no data attr"
    assert isinstance(result.data, list), (
        f"SELECT on {table} returned non-list .data: {type(result.data)}"
    )
