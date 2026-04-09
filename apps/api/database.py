"""Database client factory -- Supabase or SQLite.

Set ``QUORUM_LOCAL=true`` to use a local SQLite database instead of Supabase.
Optionally set ``QUORUM_DB_PATH`` to control the SQLite file location
(defaults to ``quorum_local.db`` in the working directory).
"""

import os
from typing import Any

from dotenv import load_dotenv

load_dotenv()

_client: Any = None


def get_supabase() -> Any:
    """Return a DB client.  Uses SQLite when ``QUORUM_LOCAL=true``, else Supabase."""
    global _client
    if _client is not None:
        return _client

    if os.environ.get("QUORUM_LOCAL", "").lower() in ("true", "1", "yes"):
        from db.sqlite_client import SQLiteClient

        db_path = os.environ.get("QUORUM_DB_PATH", "quorum_local.db")
        _client = SQLiteClient(db_path)
        return _client

    from supabase import Client, create_client

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    _client = create_client(url, key)
    return _client


def reset_client() -> None:
    """Reset the cached client (useful for testing)."""
    global _client
    _client = None
