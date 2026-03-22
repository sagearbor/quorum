"""Local LLM provider via Ollama — zero cloud dependency.

Ollama exposes an OpenAI-compatible API, so we reuse the openai SDK
pointed at the local endpoint.

Uses env vars:
    OLLAMA_BASE_URL   (default: http://localhost:11434)
    OLLAMA_MODEL      (default: llama3.3)
"""

from __future__ import annotations

import os

from openai import AsyncOpenAI

from quorum_llm.interface import LLMProvider
from quorum_llm.models import LLMTier
from quorum_llm.tier1 import extract_keywords

_DEFAULT_BASE_URL = "http://localhost:11434"
_DEFAULT_MODEL = "llama3.3"


class LocalOllamaProvider(LLMProvider):
    """Ollama-backed local LLM provider."""

    def __init__(
        self,
        base_url: str | None = None,
        model: str | None = None,
    ):
        self._base_url = base_url or os.environ.get("OLLAMA_BASE_URL", _DEFAULT_BASE_URL)
        self._model = model or os.environ.get("OLLAMA_MODEL", _DEFAULT_MODEL)
        # Ollama serves an OpenAI-compatible API at /v1
        self._client = AsyncOpenAI(
            base_url=f"{self._base_url.rstrip('/')}/v1",
            api_key="ollama",  # Ollama doesn't need a real key
        )

    async def complete(self, prompt: str, tier: LLMTier) -> str:
        if tier == LLMTier.KEYWORD:
            return ", ".join(extract_keywords(prompt))

        response = await self._client.chat.completions.create(
            model=self._model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3 if tier == LLMTier.CONFLICT else 0.7,
        )
        return response.choices[0].message.content or ""

    async def embed(self, text: str) -> list[float]:
        response = await self._client.embeddings.create(
            model=self._model,
            input=text,
        )
        return response.data[0].embedding
