"""Factory for selecting coordination backend at runtime.

Set COORDINATION_BACKEND=a2a to use A2A protocol.
Default: supabase.
"""

from __future__ import annotations

import logging
import os

from .backend import CoordinationBackend

logger = logging.getLogger(__name__)

_backend: CoordinationBackend | None = None


def get_coordination_backend() -> CoordinationBackend:
    """Return the configured coordination backend (singleton)."""
    global _backend
    if _backend is not None:
        return _backend

    backend_name = os.environ.get("COORDINATION_BACKEND", "supabase")

    if backend_name == "a2a":
        from .a2a_backend import A2ABackend
        _backend = A2ABackend()
    else:
        from .supabase_backend import SupabaseBackend
        _backend = SupabaseBackend()

    logger.info("Coordination backend: %s", backend_name)
    return _backend


def get_backend_name() -> str:
    """Return the configured backend name string."""
    return os.environ.get("COORDINATION_BACKEND", "supabase")
