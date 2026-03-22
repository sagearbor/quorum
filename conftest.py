"""Root conftest — prevent real Supabase connections during tests."""

import os
from unittest.mock import MagicMock, patch

os.environ.setdefault("QUORUM_TEST_MODE", "true")
os.environ.setdefault("SUPABASE_URL", "https://mock.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "mock-key")


def _make_mock_table(name):
    tbl = MagicMock()
    if name == "events":
        chain = MagicMock()
        chain.execute.return_value = MagicMock(
            data={"id": "evt-001", "slug": "test-event"}
        )
        tbl.select.return_value.eq.return_value.single.return_value = chain
        tbl.select.return_value.eq.return_value.execute.return_value = MagicMock(data=[])
    elif name == "quorums":
        single_chain = MagicMock()
        single_chain.execute.return_value = MagicMock(
            data={"id": "quorum-001", "status": "open"}
        )
        tbl.select.return_value.eq.return_value.single.return_value = single_chain
        tbl.insert.return_value.execute.return_value = MagicMock(data=[{"id": "quorum-001"}])
        tbl.update.return_value.eq.return_value.execute.return_value = MagicMock(data=[{}])
    elif name == "roles":
        eq_chain = MagicMock()
        eq_chain.execute.return_value = MagicMock(
            data=[{"id": "role-1"}, {"id": "role-2"}]
        )
        tbl.select.return_value.eq.return_value = eq_chain
        tbl.insert.return_value.execute.return_value = MagicMock(data=[{}])
    elif name == "contributions":
        tbl.insert.return_value.execute.return_value = MagicMock(data=[{}])
    return tbl


_mock_supabase = MagicMock()
_mock_supabase.table = MagicMock(side_effect=_make_mock_table)

# Patch create_client at the supabase library level to prevent real connections.
# This must happen before any code calls get_supabase().
_patcher = patch("supabase.create_client", return_value=_mock_supabase)
_patcher.start()

# Also patch it in the database module (already bound reference)
import apps.api.database as _db_mod
_db_mod.create_client = MagicMock(return_value=_mock_supabase)
