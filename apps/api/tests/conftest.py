"""Pytest configuration for apps/api tests.

Sets up module-level mocks for external dependencies (quorum_llm, supabase)
that may not be installed in the CI/dev Python environment.  These mocks are
installed into sys.modules before any route module is imported so that
top-level import statements succeed.
"""

from __future__ import annotations

import os
import sys
import types
from unittest.mock import AsyncMock, MagicMock

import pytest

# Ensure apps/api is on sys.path so that bare imports in main.py
# (e.g. `from routes import router`) resolve when tests import
# `apps.api.main` as a package path.
_API_DIR = os.path.join(os.path.dirname(__file__), os.pardir)
_API_DIR = os.path.abspath(_API_DIR)
if _API_DIR not in sys.path:
    sys.path.insert(0, _API_DIR)


def _alias_bare_modules() -> None:
    """Ensure bare-imported modules (e.g. `routes`) and their qualified
    counterparts (e.g. `apps.api.routes`) always refer to the same object.

    When main.py does `from routes import router`, Python loads routes.py as
    the module `routes`. But tests patch `apps.api.routes.get_supabase`.
    Without aliasing, those are different module objects and patches miss.
    """
    _bare_names = [
        "routes", "seed_loader", "database", "health", "models",
        "agent_engine", "document_engine", "llm", "tag_vocabulary",
    ]
    for name in _bare_names:
        qualified = f"apps.api.{name}"
        bare = sys.modules.get(name)
        qual = sys.modules.get(qualified)
        if bare is not None and qual is not None and bare is not qual:
            # Both exist but differ — prefer qualified (it's what patches target)
            sys.modules[name] = qual
        elif bare is not None and qual is None:
            sys.modules[qualified] = bare
        elif qual is not None and bare is None:
            sys.modules[name] = qual


def _install_quorum_llm_mock() -> None:
    """Install a minimal quorum_llm stub into sys.modules."""
    if "quorum_llm" in sys.modules:
        return

    pkg = types.ModuleType("quorum_llm")

    # Enums / models
    from enum import IntEnum

    class LLMTier(IntEnum):
        KEYWORD = 1
        CONFLICT = 2
        AGENT_CHAT = 21
        AGENT_RESPOND = 22
        SYNTHESIS = 3
        AGENT_REASON = 31

    class Role:
        def __init__(self, id, name, authority_rank, capacity="unlimited"):
            self.id = id
            self.name = name
            self.authority_rank = authority_rank
            self.capacity = capacity

    class Contribution:
        def __init__(self, id, role_id, content, structured_fields=None, tier_processed=1):
            self.id = id
            self.role_id = role_id
            self.content = content
            self.structured_fields = structured_fields or {}
            self.tier_processed = tier_processed

    class Quorum:
        def __init__(self, id, title, description, roles=None, status="active"):
            self.id = id
            self.title = title
            self.description = description
            self.roles = roles or []
            self.status = status

    class ArtifactSection:
        def __init__(self, title, content, source_contribution_ids=None):
            self.title = title
            self.content = content
            self.source_contribution_ids = source_contribution_ids or []

    class ArtifactContent:
        def __init__(self, sections=None, content_hash="mock-hash", conflicts_resolved=None):
            self.sections = sections or []
            self.content_hash = content_hash
            self.conflicts_resolved = conflicts_resolved or []

    async def detect_conflicts(contribs, roles, provider):
        return []

    async def generate_artifact(quorum, contribs, provider):
        return ArtifactContent(sections=[], content_hash="mock-hash")

    async def synthesize_contributions(contribs, roles, tier, provider):
        return "mock synthesis"

    def find_overlapping_fields(fields_lists):
        return []

    def get_llm_provider(name="mock", **kwargs):
        mock = MagicMock()
        mock.complete = AsyncMock(return_value="mock response")
        mock.embed = AsyncMock(return_value=[0.1] * 10)
        return mock

    # Attach everything to the stub package
    pkg.LLMTier = LLMTier
    pkg.Role = Role
    pkg.Contribution = Contribution
    pkg.Quorum = Quorum
    pkg.ArtifactSection = ArtifactSection
    pkg.ArtifactContent = ArtifactContent
    pkg.detect_conflicts = detect_conflicts
    pkg.generate_artifact = generate_artifact
    pkg.synthesize_contributions = synthesize_contributions
    pkg.find_overlapping_fields = find_overlapping_fields
    pkg.get_llm_provider = get_llm_provider

    sys.modules["quorum_llm"] = pkg

    # Sub-module stubs that are imported by name in various files
    for sub in ("interface", "models", "factory", "providers.mock", "tier1", "affinity", "conversation"):
        full = f"quorum_llm.{sub}"
        if full not in sys.modules:
            stub = types.ModuleType(full)
            if sub == "models":
                stub.LLMTier = LLMTier
            elif sub == "interface":
                from abc import ABC, abstractmethod

                class LLMProvider(ABC):
                    @abstractmethod
                    async def complete(self, prompt: str, tier) -> str: ...
                    @abstractmethod
                    async def embed(self, text: str) -> list: ...

                stub.LLMProvider = LLMProvider
            elif sub == "factory":
                stub.get_llm_provider = get_llm_provider
            elif sub == "tier1":
                stub.extract_keywords = lambda text, **kw: text.lower().split()[:5]
            elif sub == "affinity":
                stub.compute_tag_affinity = lambda a, b: len(set(a) & set(b)) / max(len(set(a) | set(b)), 1)
                stub.extract_tags_from_text = lambda text, existing_vocabulary=None, vocab=None: text.lower().split()[:5]
                stub.find_relevant_agents = lambda tags, agents, threshold=0.2: agents
                stub.build_affinity_graph = lambda agents: {}
                stub.canonicalize_tag = lambda t: t.lower().replace(" ", "_")[:30]
                stub.merge_tag_vocabularies = lambda existing, new, max_size=500: existing | set(new)
            elif sub == "conversation":
                stub.build_agent_prompt = lambda **kw: [{"role": "user", "content": "mock"}]
                stub.extract_tags_from_response = lambda text, tags=None: []
                stub.summarize_history = lambda msgs, max_t, **kw: msgs[-5:]
            sys.modules[full] = stub

    # Also wire quorum_llm.providers as a package
    providers_pkg = types.ModuleType("quorum_llm.providers")
    sys.modules["quorum_llm.providers"] = providers_pkg


def _install_supabase_mock() -> None:
    """Install a minimal supabase stub into sys.modules."""
    if "supabase" in sys.modules:
        return

    pkg = types.ModuleType("supabase")

    class Client:
        pass

    def create_client(url, key):
        return MagicMock()

    pkg.Client = Client
    pkg.create_client = create_client
    sys.modules["supabase"] = pkg

    # dotenv may also not be installed
    if "dotenv" not in sys.modules:
        dotenv_stub = types.ModuleType("dotenv")
        dotenv_stub.load_dotenv = lambda: None
        sys.modules["dotenv"] = dotenv_stub


# Install mocks at import time so that subsequent imports of routes.py succeed
_install_quorum_llm_mock()
_install_supabase_mock()

# Pre-import key modules via their qualified path, then alias the bare name
# to the same object. This ensures that when main.py does `from routes import
# router` during importlib.reload(), it gets the same module object that
# unittest.mock.patch("apps.api.routes.xxx") targets.
import importlib as _importlib

for _name in [
    "routes", "seed_loader", "database", "health", "models",
    "agent_engine", "document_engine", "llm", "tag_vocabulary",
]:
    _qualified = f"apps.api.{_name}"
    try:
        _mod = _importlib.import_module(_qualified)
        sys.modules[_name] = _mod  # bare name → same object
    except ImportError:
        pass

_alias_bare_modules()
