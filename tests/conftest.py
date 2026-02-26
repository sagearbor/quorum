"""Shared pytest fixtures for Stream G tests."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Ensure packages are importable
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "llm"))
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT / "apps"))

# Force test mode before any imports that touch the factory
os.environ["QUORUM_TEST_MODE"] = "true"

from quorum_llm.providers.mock import MockLLMProvider


@pytest.fixture
def mock_provider():
    """Fresh MockLLMProvider for each test."""
    return MockLLMProvider()
