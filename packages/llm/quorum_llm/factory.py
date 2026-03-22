"""Factory for instantiating LLM providers by name."""

from __future__ import annotations

import os

from quorum_llm.interface import LLMProvider

# Registry of known providers — lazy imports to avoid pulling in unused SDKs
_PROVIDERS: dict[str, str] = {
    "openai": "quorum_llm.providers.openai:OpenAIProvider",
    "azure": "quorum_llm.providers.azure:AzureOpenAIProvider",
    "anthropic": "quorum_llm.providers.anthropic:AnthropicProvider",
    "local": "quorum_llm.providers.local:LocalOllamaProvider",
    "mock": "quorum_llm.providers.mock:MockLLMProvider",
}


def get_llm_provider(provider_name: str = "azure", **kwargs) -> LLMProvider:
    """Instantiate an LLM provider by name.

    When QUORUM_TEST_MODE=true is set, always returns MockLLMProvider
    regardless of provider_name.

    Args:
        provider_name: One of "openai", "azure", "anthropic", "local", "mock".
        **kwargs: Forwarded to the provider constructor.

    Returns:
        An initialized LLMProvider instance.

    Raises:
        ValueError: If provider_name is not recognized.
    """
    if os.environ.get("QUORUM_TEST_MODE", "").lower() in ("true", "1", "yes"):
        from quorum_llm.providers.mock import MockLLMProvider

        return MockLLMProvider()

    target = _PROVIDERS.get(provider_name)
    if target is None:
        known = ", ".join(sorted(_PROVIDERS))
        raise ValueError(
            f"Unknown LLM provider '{provider_name}'. Known providers: {known}"
        )

    module_path, class_name = target.split(":")
    import importlib

    module = importlib.import_module(module_path)
    cls = getattr(module, class_name)
    return cls(**kwargs)
