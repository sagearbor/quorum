"""Factory for instantiating LLM providers by name."""

from __future__ import annotations

from quorum_llm.interface import LLMProvider

# Registry of known providers — lazy imports to avoid pulling in unused SDKs
_PROVIDERS: dict[str, str] = {
    "azure": "quorum_llm.providers.azure:AzureOpenAIProvider",
    "anthropic": "quorum_llm.providers.anthropic:AnthropicProvider",
}


def get_llm_provider(provider_name: str = "azure", **kwargs) -> LLMProvider:
    """Instantiate an LLM provider by name.

    Args:
        provider_name: One of "azure", "anthropic". Matches CONTRACT.md LLMProvider enum.
        **kwargs: Forwarded to the provider constructor.

    Returns:
        An initialized LLMProvider instance.

    Raises:
        ValueError: If provider_name is not recognized.
    """
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
