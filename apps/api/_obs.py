"""Observability shim — thin facade over Logfire for hot-path instrumentation.

Why a shim?

  The application code wants to write ``with span("autonomy_round", quorum_id=...)``
  on a hot path WITHOUT having to repeat a try/except ImportError guard at every
  call site.  ``logfire.span`` is the real implementation when the package is
  installed; otherwise we return a no-op ``nullcontext`` so the ``with`` block
  is free.

  Logfire itself is already careful — ``logfire.configure(send_to_logfire=
  'if-token-present')`` makes the SDK a no-op without a token, so even when
  ``logfire`` IS installed the spans are cheap when ``LOGFIRE_TOKEN`` is
  unset.  This shim purely guards the import-time failure case (minimal CI
  images, broken installs) so the API never crashes for an observability
  dependency.

Public API:

  - ``span(name, **attributes)``: context manager.  Use exactly like
    ``logfire.span`` — pass kwargs that become span attributes.

Example:

    from _obs import span

    async def _run_autonomy_round(quorum_id, ...):
        with span("autonomy_round", quorum_id=quorum_id, round_num=round_num):
            ...
"""

from __future__ import annotations

import contextlib
import logging
from typing import Any, Iterator

logger = logging.getLogger(__name__)

try:
    import logfire as _logfire  # type: ignore[import-not-found]
    _HAS_LOGFIRE = True
except ImportError:
    _logfire = None  # type: ignore[assignment]
    _HAS_LOGFIRE = False


@contextlib.contextmanager
def span(name: str, **attributes: Any) -> Iterator[Any]:
    """Open a Logfire span if available, else a no-op context.

    Yields the live ``LogfireSpan`` object when Logfire is installed (so the
    caller may attach extra attributes mid-block via ``span.set_attribute``),
    or ``None`` otherwise.  Any exception raised inside the block propagates
    unchanged — Logfire records it on the span automatically.

    Errors from the span-creation path itself are swallowed: observability
    must never break the hot path.
    """
    if not _HAS_LOGFIRE:
        yield None
        return

    try:
        with _logfire.span(name, **attributes) as s:  # type: ignore[union-attr]
            yield s
    except Exception:  # noqa: BLE001 — observability must never fail
        logger.debug("logfire.span(%r) failed; running block uninstrumented", name, exc_info=True)
        yield None
