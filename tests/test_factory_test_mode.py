"""Tests for QUORUM_TEST_MODE env var support in factory."""

from __future__ import annotations

import os

import pytest

from quorum_llm.factory import get_llm_provider
from quorum_llm.providers.mock import MockLLMProvider


def test_test_mode_returns_mock():
    """QUORUM_TEST_MODE=true should always return MockLLMProvider."""
    os.environ["QUORUM_TEST_MODE"] = "true"
    provider = get_llm_provider("azure")
    assert isinstance(provider, MockLLMProvider)


def test_test_mode_case_insensitive():
    os.environ["QUORUM_TEST_MODE"] = "True"
    provider = get_llm_provider("anthropic")
    assert isinstance(provider, MockLLMProvider)


def test_test_mode_numeric():
    os.environ["QUORUM_TEST_MODE"] = "1"
    provider = get_llm_provider("azure")
    assert isinstance(provider, MockLLMProvider)


def test_mock_provider_by_name():
    """Can also request mock provider explicitly."""
    os.environ.pop("QUORUM_TEST_MODE", None)
    provider = get_llm_provider("mock")
    assert isinstance(provider, MockLLMProvider)
