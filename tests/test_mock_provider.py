"""Tests for MockLLMProvider — deterministic responses, no API calls."""

from __future__ import annotations

import json

import pytest

from quorum_llm.models import LLMTier
from quorum_llm.providers.mock import MockLLMProvider


@pytest.fixture
def provider():
    return MockLLMProvider()


@pytest.mark.asyncio
async def test_tier1_returns_keywords(provider):
    result = await provider.complete(
        "The clinical trial protocol requires safety monitoring", LLMTier.KEYWORD
    )
    assert isinstance(result, str)
    assert len(result) > 0
    # Tier 1 extracts keywords — should contain domain terms
    assert "clinical" in result or "trial" in result or "protocol" in result


@pytest.mark.asyncio
async def test_tier2_conflict_detected(provider):
    prompt = (
        "Analyze the following contributions for field 'dosing_interval' "
        "and determine if there are conflicts.\n\n"
        "- [Principal Investigator (rank 2)] (contribution c1): 12 weeks\n"
        "- [IRB Representative (rank 3)] (contribution c2): 6-week safety checkpoint\n\n"
        'Respond with JSON: {"has_conflict": bool, "description": str, '
        '"severity": "low"|"medium"|"high"}'
    )
    result = await provider.complete(prompt, LLMTier.CONFLICT)
    parsed = json.loads(result)
    assert parsed["has_conflict"] is True
    assert parsed["severity"] == "high"


@pytest.mark.asyncio
async def test_tier2_no_conflict(provider):
    # Single contribution line → no conflict
    prompt = (
        "Analyze the following contributions for field 'timeline' "
        "and determine if there are conflicts.\n\n"
        "All agree on 24-week timeline.\n\n"
        'Respond with JSON: {"has_conflict": bool, "description": str, '
        '"severity": "low"|"medium"|"high"}'
    )
    result = await provider.complete(prompt, LLMTier.CONFLICT)
    parsed = json.loads(result)
    assert parsed["has_conflict"] is False


@pytest.mark.asyncio
async def test_tier3_returns_sections(provider):
    prompt = "Generate artifact for clinical trial quorum"
    result = await provider.complete(prompt, LLMTier.SYNTHESIS)
    sections = json.loads(result)
    assert isinstance(sections, list)
    assert len(sections) >= 3
    assert all("title" in s and "content" in s for s in sections)
    # Check for realistic clinical content
    titles = [s["title"] for s in sections]
    assert "Protocol Summary" in titles


@pytest.mark.asyncio
async def test_embed_deterministic(provider):
    vec1 = await provider.embed("clinical trial safety")
    vec2 = await provider.embed("clinical trial safety")
    assert vec1 == vec2
    assert len(vec1) == 256


@pytest.mark.asyncio
async def test_embed_different_inputs(provider):
    vec1 = await provider.embed("clinical trial")
    vec2 = await provider.embed("something completely different")
    assert vec1 != vec2


@pytest.mark.asyncio
async def test_call_log(provider):
    await provider.complete("hello", LLMTier.KEYWORD)
    await provider.complete("world", LLMTier.SYNTHESIS)
    await provider.embed("test")
    assert len(provider.call_log) == 3
    assert provider.call_log[0]["tier"] == 1
    assert provider.call_log[1]["tier"] == 3
    assert provider.call_log[2]["tier"] == "embed"
