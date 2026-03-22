"""LLM provider wiring — connects FastAPI routes to packages/llm/.

Uses quorum_llm.get_llm_provider() which respects QUORUM_TEST_MODE env var.
Provider selection: QUORUM_LLM_PROVIDER env var (default "openai").
"""

from __future__ import annotations

import os

from quorum_llm import get_llm_provider
from quorum_llm.interface import LLMProvider

_llm_provider: LLMProvider | None = None


def _get_provider() -> LLMProvider:
    global _llm_provider
    if _llm_provider is None:
        provider_name = os.environ.get("QUORUM_LLM_PROVIDER", "openai")
        _llm_provider = get_llm_provider(provider_name)
    return _llm_provider


class _LazyProvider:
    """Proxy that defers provider creation until first use."""

    def __getattr__(self, name):
        return getattr(_get_provider(), name)


# Module-level instance used by route handlers.
# Lazy: actual provider created on first attribute access, not at import time.
llm_provider: LLMProvider = _LazyProvider()  # type: ignore[assignment]
