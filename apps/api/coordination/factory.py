"""Factory for selecting coordination backend at runtime.

Set COORDINATION_BACKEND=a2a to use A2A protocol.
Default: supabase.

Per-process caching
-------------------

We use ``functools.lru_cache(maxsize=1)`` so the backend is constructed
exactly once per worker process. This is the right scope:

  • Backend instances are cheap to construct (just config + httpx client).
  • They carry no shared state we want to leak across workers.
  • lru_cache is thread-safe in CPython without our own lock.

This is the only intentional "module-level singleton" we keep after the
11.5 migration: unlike the autonomy-loop dict and the agent-registry dict,
nothing about coordination backend correctness depends on cross-worker
agreement. Each worker can have its own.
"""

from __future__ import annotations

import functools
import logging
import os

from .backend import CoordinationBackend

logger = logging.getLogger(__name__)


@functools.lru_cache(maxsize=1)
def get_coordination_backend() -> CoordinationBackend:
    """Return the configured coordination backend (per-process cached).

    The lru_cache(maxsize=1) decorator gives us:
      - Lazy construction (first call instantiates, subsequent calls return cached).
      - Explicit per-process scope (no shared mutable module-level global).
      - get_coordination_backend.cache_clear() for tests that need a fresh
        instance after monkey-patching COORDINATION_BACKEND.
    """
    backend_name = os.environ.get("COORDINATION_BACKEND", "supabase")

    if backend_name == "a2a":
        from .a2a_backend import A2ABackend
        backend: CoordinationBackend = A2ABackend()
    else:
        from .supabase_backend import SupabaseBackend
        backend = SupabaseBackend()

    logger.info("Coordination backend: %s", backend_name)
    return backend


def get_backend_name() -> str:
    """Return the configured backend name string."""
    return os.environ.get("COORDINATION_BACKEND", "supabase")
