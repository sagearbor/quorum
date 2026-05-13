"""Helper to run sync Supabase builder chains without blocking the event loop.

The Supabase Python client (``supabase-py``) is synchronous — every
``.execute()`` call blocks the calling thread. Inside FastAPI's async loop
that stalls every other coroutine until the DB responds, which under
heavy autonomy load (4+ quorums × autonomy 1.0) shows up as WebSocket
disconnects, missed heartbeats, and visible UI freezes.

Wrapping each call in ``asyncio.to_thread`` pushes the blocking work onto
the default thread-pool executor so the event loop keeps spinning. This
is checklist item 12.6 — see ``docs/DECISIONS.md`` for the rationale and
``docs/CONTRACT.md`` for the call-site contract.

Usage::

    # Before:
    result = db.table("roles").select("*").eq("quorum_id", q).execute()

    # After:
    from db.aexec import aexec
    result = await aexec(db.table("roles").select("*").eq("quorum_id", q))

For builder chains that need additional kwargs at ``.execute()`` time, or
for ad-hoc blocking work, pass a zero-arg callable (a "thunk")::

    result = await aexec(lambda: db.table("foo").insert(rows).execute())

The wrapper returns whatever the underlying ``.execute()`` returns — in
``supabase-py`` 2.x that is an :class:`APIResponse`. Type hints on the
caller side are preserved.

Notes:
- This is a deliberately small surface. Approach B (a full migration to
  ``supabase-py-async`` / ``supabase.AsyncClient``) is documented as a
  post-expo follow-up: same idea but with a much wider blast radius.
- Mock-based tests still work — ``MagicMock().execute`` is callable, so
  ``asyncio.to_thread`` happily runs it in the pool.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar, Union

T = TypeVar("T")


async def aexec(builder_or_thunk: Union[Any, Callable[[], T]]) -> T:
    """Run a sync Supabase ``.execute()`` (or arbitrary thunk) in a thread.

    Args:
        builder_or_thunk: Either a Supabase builder (any object with an
            ``.execute()`` method) or a zero-arg callable returning the
            result you want.

    Dispatch rule:
        If the argument has an ``execute`` attribute, treat it as a
        builder and run ``builder.execute()`` in a thread. Otherwise,
        treat it as a thunk and call it in a thread. We check ``execute``
        first because :class:`unittest.mock.MagicMock` instances are
        themselves callable (every attribute access auto-creates a
        callable child mock), so a naive ``callable()`` test would
        misclassify mock builders as thunks.

    Returns:
        Whatever ``.execute()`` (or the thunk) returned, unchanged.
    """
    execute_attr = getattr(builder_or_thunk, "execute", None)
    if execute_attr is not None and callable(execute_attr):
        # Builder form: ``aexec(db.table(...).select(...).eq(...))``.
        return await asyncio.to_thread(execute_attr)
    if callable(builder_or_thunk):
        # Thunk form: ``aexec(lambda: db.table(...).execute())``.
        return await asyncio.to_thread(builder_or_thunk)
    raise TypeError(
        f"aexec expected a Supabase builder (with .execute()) or a zero-arg "
        f"callable, got {type(builder_or_thunk).__name__}"
    )


__all__ = ["aexec"]
