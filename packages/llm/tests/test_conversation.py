"""Tests for the conversation module (prompt building, tag extraction, history summarization).

Covers:
- build_agent_prompt: message structure, system content, context assembly
- extract_tags_from_response: explicit [tags:] blocks, keyword extraction, dedup
- summarize_history: short history passthrough, summarization call, LLM failure fallback
- chat() method: MockLLMProvider implementation, AGENT_CHAT tier routing
"""

from __future__ import annotations

import pytest

from quorum_llm.conversation import (
    AgentDocumentContext,
    AgentInsightContext,
    AgentRequestContext,
    QuorumContext,
    RoleContext,
    build_agent_prompt,
    extract_tags_from_response,
    summarize_history,
)
from quorum_llm.interface import LLMProvider
from quorum_llm.models import LLMTier
from quorum_llm.providers.mock import MockLLMProvider


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class CapturingProvider(LLMProvider):
    """Minimal provider that records calls and returns configurable responses."""

    def __init__(self, response: str = "mock summary"):
        self.calls: list[tuple[str, LLMTier]] = []
        self.chat_calls: list[tuple[list[dict[str, str]], LLMTier]] = []
        self._response = response

    async def complete(self, prompt: str, tier: LLMTier) -> str:
        self.calls.append((prompt, tier))
        return self._response

    async def embed(self, text: str) -> list[float]:
        return [0.0] * 10

    async def chat(
        self,
        messages: list[dict[str, str]],
        tier: LLMTier,
        temperature: float = 0.4,
        max_tokens: int = 1024,
    ) -> str:
        self.chat_calls.append((messages, tier))
        # Record flattened form in calls too for unified assertions
        flat = "\n".join(f"[{m['role']}]: {m['content']}" for m in messages)
        self.calls.append((flat, tier))
        return self._response


class FailingProvider(LLMProvider):
    """Provider that always raises on complete() to test error paths."""

    async def complete(self, prompt: str, tier: LLMTier) -> str:
        raise RuntimeError("simulated LLM failure")

    async def embed(self, text: str) -> list[float]:
        return []


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def role() -> RoleContext:
    return RoleContext(
        role_id="role-irb",
        role_name="IRB Officer",
        authority_rank=4,
        domain_tags=["irb", "ethics", "consent", "regulatory"],
    )


@pytest.fixture
def quorum() -> QuorumContext:
    return QuorumContext(
        quorum_id="quorum-001",
        title="Phase II Safety Review",
        description="Multi-site clinical trial safety evaluation.",
        max_authority_rank=5,
    )


@pytest.fixture
def documents() -> list[AgentDocumentContext]:
    return [
        AgentDocumentContext(
            document_id="doc-001",
            title="Protocol v2",
            doc_type="protocol",
            version=3,
            content={"sections": {"dosing": {"interval_weeks": 6}}},
            tags=["protocol", "dosing", "irb"],
            last_editor_name="Safety Monitor",
        ),
    ]


@pytest.fixture
def insights() -> list[AgentInsightContext]:
    return [
        AgentInsightContext(
            insight_id="ins-001",
            source_role_name="Safety Monitor",
            insight_type="conflict",
            content="Dosing interval conflict: PI proposes 12 weeks, IRB requires 6.",
            tags=["dosing", "safety_monitoring", "irb"],
            created_at="2026-03-14T10:00:00Z",
        ),
    ]


@pytest.fixture
def pending_requests() -> list[AgentRequestContext]:
    return [
        AgentRequestContext(
            request_id="req-001",
            from_role_name="Budget Analyst",
            request_type="input_request",
            content="Can you confirm the eGFR threshold that triggers a dose hold?",
            tags=["egfr", "dosing", "irb"],
            priority=2,
        ),
    ]


# ---------------------------------------------------------------------------
# Tests: build_agent_prompt
# ---------------------------------------------------------------------------


def test_build_agent_prompt_structure(role, quorum, documents, insights, pending_requests):
    """Prompt must start with system, followed by context user message, then history."""
    history = [
        {"role": "user", "content": "What is the current dosing interval?"},
        {"role": "assistant", "content": "The current protocol specifies 6 weeks."},
    ]
    messages = build_agent_prompt(
        agent_instructions="Review all protocol documents for compliance.",
        role=role,
        quorum=quorum,
        contributions=[],
        insights=insights,
        documents=documents,
        history=history,
        pending_requests=pending_requests,
        latest_message="Please confirm eGFR thresholds.",
    )

    # Must have at least: system, context block, history (2), latest message
    assert len(messages) >= 4

    # First message is always system
    assert messages[0]["role"] == "system"
    assert "IRB Officer" in messages[0]["content"]
    assert "Phase II Safety Review" in messages[0]["content"]
    assert "authority rank: 4" in messages[0]["content"]

    # System message must contain the agent instructions verbatim
    assert "Review all protocol documents for compliance." in messages[0]["content"]

    # Last message is always the latest user input
    assert messages[-1]["role"] == "user"
    assert "eGFR thresholds" in messages[-1]["content"]


def test_build_agent_prompt_context_includes_documents(role, quorum, documents):
    """Context block user message should mention document title and version."""
    messages = build_agent_prompt(
        agent_instructions="",
        role=role,
        quorum=quorum,
        contributions=[],
        insights=[],
        documents=documents,
        history=[],
        latest_message="Check the protocol.",
    )

    context_msg = next(m for m in messages if m["role"] == "user" and "ACTIVE DOCUMENTS" in m["content"])
    assert "Protocol v2" in context_msg["content"]
    assert "v3" in context_msg["content"]
    assert "Safety Monitor" in context_msg["content"]


def test_build_agent_prompt_context_includes_insights(role, quorum, insights):
    """Context block must include cross-station insights."""
    messages = build_agent_prompt(
        agent_instructions="",
        role=role,
        quorum=quorum,
        contributions=[],
        insights=insights,
        documents=[],
        history=[],
        latest_message="Any known conflicts?",
    )

    content = " ".join(m["content"] for m in messages)
    assert "CROSS-STATION INSIGHTS" in content
    assert "Dosing interval conflict" in content


def test_build_agent_prompt_context_includes_pending_requests(role, quorum, pending_requests):
    """Pending A2A requests must appear in the context block."""
    messages = build_agent_prompt(
        agent_instructions="",
        role=role,
        quorum=quorum,
        contributions=[],
        insights=[],
        documents=[],
        history=[],
        pending_requests=pending_requests,
        latest_message="",
    )

    content = " ".join(m["content"] for m in messages)
    assert "PENDING REQUESTS" in content
    assert "Budget Analyst" in content
    assert "eGFR threshold" in content


def test_build_agent_prompt_no_empty_context_message(role, quorum):
    """If there is no context (no docs, no insights, no requests), skip context message."""
    messages = build_agent_prompt(
        agent_instructions="",
        role=role,
        quorum=quorum,
        contributions=[],
        insights=[],
        documents=[],
        history=[],
        latest_message="Hello.",
    )

    # Should have system + history + latest (no context block)
    user_msgs = [m for m in messages if m["role"] == "user"]
    # The only user message should be the latest_message (no empty context block)
    assert all(m["content"].strip() for m in user_msgs), "No user message should be blank"


def test_build_agent_prompt_history_preserves_order(role, quorum):
    """Conversation history messages must appear in original order between context and latest."""
    history = [
        {"role": "user", "content": "First user message"},
        {"role": "assistant", "content": "First assistant reply"},
        {"role": "user", "content": "Second user message"},
        {"role": "assistant", "content": "Second assistant reply"},
    ]
    messages = build_agent_prompt(
        agent_instructions="",
        role=role,
        quorum=quorum,
        contributions=[],
        insights=[],
        documents=[],
        history=history,
        latest_message="Third user message",
    )

    # Find positions of history messages by content
    contents = [m["content"] for m in messages]
    assert contents.index("First user message") < contents.index("Second user message")
    assert contents.index("Second assistant reply") < contents.index("Third user message")


def test_build_agent_prompt_domain_tags_in_system(role, quorum):
    """Domain tags must appear in the system message."""
    messages = build_agent_prompt(
        agent_instructions="",
        role=role,
        quorum=quorum,
        contributions=[],
        insights=[],
        documents=[],
        history=[],
        latest_message="",
    )

    system_content = messages[0]["content"]
    assert "irb" in system_content
    assert "ethics" in system_content


def test_build_agent_prompt_no_latest_message_allowed(role, quorum):
    """Omitting latest_message (empty string) should not append a blank message."""
    messages = build_agent_prompt(
        agent_instructions="",
        role=role,
        quorum=quorum,
        contributions=[],
        insights=[],
        documents=[],
        history=[{"role": "user", "content": "Previous input"}],
        latest_message="",
    )

    # No empty content messages
    assert all(m["content"].strip() for m in messages)


def test_build_agent_prompt_contributions_included(role, quorum):
    """Recent human contributions should appear in the context block."""
    contributions = [
        {"role": "user", "content": "Patient reported adverse event at week 4."},
    ]
    messages = build_agent_prompt(
        agent_instructions="",
        role=role,
        quorum=quorum,
        contributions=contributions,
        insights=[],
        documents=[],
        history=[],
        latest_message="Is this reportable?",
    )

    content = " ".join(m["content"] for m in messages)
    assert "adverse event" in content


# ---------------------------------------------------------------------------
# Tests: extract_tags_from_response
# ---------------------------------------------------------------------------


def test_extract_tags_explicit_block():
    """Tags in [tags: ...] blocks must be extracted and canonicalized."""
    response = "The dosing interval should remain at 6 weeks. [tags: dosing, irb, safety monitoring]"
    tags = extract_tags_from_response(response, [])
    assert "dosing" in tags
    assert "irb" in tags
    assert "safety_monitoring" in tags  # space → underscore


def test_extract_tags_multiple_blocks():
    """Multiple [tags:] blocks in a single response are all collected."""
    response = (
        "First point about enrollment [tags: enrollment, screening]. "
        "Second point about budget [tags: budget, sponsor]."
    )
    tags = extract_tags_from_response(response, [])
    assert "enrollment" in tags
    assert "screening" in tags
    assert "budget" in tags
    assert "sponsor" in tags


def test_extract_tags_preserves_existing():
    """Existing tags must be retained even if not present in the response."""
    existing = ["regulatory", "fda"]
    response = "The new protocol amendment looks compliant. [tags: protocol]"
    tags = extract_tags_from_response(response, existing)
    assert "regulatory" in tags
    assert "fda" in tags
    assert "protocol" in tags


def test_extract_tags_deduplication():
    """Duplicate tags (from explicit block and keyword extraction) should not repeat."""
    response = "The IRB requires consent documentation. [tags: irb, consent]"
    tags = extract_tags_from_response(response, ["irb"])
    # irb should appear exactly once
    assert tags.count("irb") == 1


def test_extract_tags_canonicalization():
    """Tags with spaces, hyphens, and uppercase should be normalized."""
    response = "Issues with CRC Staffing and eGFR threshold. [tags: CRC staffing, eGFR-threshold]"
    tags = extract_tags_from_response(response, [])
    assert "crc_staffing" in tags
    assert "egfr_threshold" in tags


def test_extract_tags_max_new_tags_limit():
    """No more than max_new_tags new tags should be added per call."""
    response = "[tags: a, b, c, d, e, f, g, h, i, j]"
    tags = extract_tags_from_response(response, [], max_new_tags=3)
    assert len(tags) <= 3


def test_extract_tags_empty_response():
    """Empty response should return existing tags unchanged."""
    existing = ["irb", "consent"]
    tags = extract_tags_from_response("", existing)
    assert tags == existing


def test_extract_tags_from_response_no_block_uses_keywords():
    """When no explicit [tags:] block is present, keyword extraction fills in tags."""
    response = "The patient retention rate dropped below the enrollment threshold."
    tags = extract_tags_from_response(response, [])
    # At least some keywords should be extracted
    assert len(tags) > 0


def test_extract_tags_truncation_at_30_chars():
    """Tags longer than 30 characters must be truncated."""
    very_long = "this_is_a_very_long_tag_that_exceeds_thirty_characters"
    response = f"[tags: {very_long}]"
    tags = extract_tags_from_response(response, [])
    for tag in tags:
        assert len(tag) <= 30


# ---------------------------------------------------------------------------
# Tests: summarize_history
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_summarize_history_short_passthrough():
    """History shorter than keep_last_n should be returned unchanged."""
    provider = CapturingProvider()
    history = [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there"},
    ]
    result = await summarize_history(history, provider, keep_last_n=5)
    assert result == history
    assert len(provider.calls) == 0  # no LLM call needed


@pytest.mark.asyncio
async def test_summarize_history_calls_llm_for_long_history():
    """For histories longer than keep_last_n, LLM should be called once."""
    provider = CapturingProvider(response="Summary: discussed dosing and consent protocols.")
    history = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"msg {i}"} for i in range(12)]
    result = await summarize_history(history, provider, keep_last_n=5)

    # LLM should have been called exactly once
    assert len(provider.calls) == 1
    assert provider.calls[0][1] == LLMTier.AGENT_CHAT

    # Result must start with a summary system message
    assert result[0]["role"] == "system"
    assert "Summary" in result[0]["content"]

    # Last keep_last_n messages must be the raw recent ones
    assert result[-1] == history[-1]
    assert result[-5] == history[-5]


@pytest.mark.asyncio
async def test_summarize_history_result_length():
    """Summarized history should have: 1 summary msg + keep_last_n raw msgs."""
    provider = CapturingProvider(response="Condensed summary of prior turns.")
    history = [{"role": "user", "content": f"turn {i}"} for i in range(20)]
    result = await summarize_history(history, provider, keep_last_n=5)

    assert len(result) == 6  # 1 summary + 5 raw


@pytest.mark.asyncio
async def test_summarize_history_llm_failure_fallback():
    """If the LLM call fails, return only the last keep_last_n messages (graceful degradation)."""
    provider = FailingProvider()
    history = [{"role": "user", "content": f"msg {i}"} for i in range(10)]
    result = await summarize_history(history, provider, keep_last_n=3)

    # Should return last 3 without crashing
    assert len(result) == 3
    assert result == history[-3:]


@pytest.mark.asyncio
async def test_summarize_history_summary_message_content():
    """Summary message should reference the LLM output verbatim."""
    summary_text = "Agent reviewed dosing intervals. Conflict on eGFR threshold noted."
    provider = CapturingProvider(response=summary_text)
    history = [{"role": "user", "content": f"msg {i}"} for i in range(8)]
    result = await summarize_history(history, provider, keep_last_n=3)

    assert summary_text in result[0]["content"]


# ---------------------------------------------------------------------------
# Tests: chat() method on MockLLMProvider
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mock_provider_chat_agent_chat_tier():
    """MockLLMProvider.chat() at AGENT_CHAT tier should return agent-like response."""
    provider = MockLLMProvider()
    messages = [
        {"role": "system", "content": "You are an IRB officer."},
        {"role": "user", "content": "Confirm the consent protocol."},
    ]
    result = await provider.chat(messages, LLMTier.AGENT_CHAT)
    assert isinstance(result, str)
    assert len(result) > 0


@pytest.mark.asyncio
async def test_mock_provider_chat_records_call():
    """MockLLMProvider.chat() should record the call in call_log."""
    provider = MockLLMProvider()
    messages = [
        {"role": "system", "content": "System"},
        {"role": "user", "content": "Question"},
    ]
    await provider.chat(messages, LLMTier.AGENT_CHAT)

    # call_log should have exactly one entry
    assert len(provider.call_log) == 1
    assert provider.call_log[0]["tier"] == int(LLMTier.AGENT_CHAT)


@pytest.mark.asyncio
async def test_mock_provider_chat_agent_reason_tier():
    """MockLLMProvider.chat() at AGENT_REASON tier should also respond."""
    provider = MockLLMProvider()
    messages = [{"role": "user", "content": "Escalation context"}]
    result = await provider.chat(messages, LLMTier.AGENT_REASON)
    assert isinstance(result, str)
    assert len(result) > 0


@pytest.mark.asyncio
async def test_base_interface_chat_fallback():
    """The default LLMProvider.chat() implementation should flatten and call complete()."""
    provider = CapturingProvider(response="flat response")
    messages = [
        {"role": "system", "content": "You are an agent."},
        {"role": "user", "content": "Hello."},
    ]
    # CapturingProvider does NOT override chat() the same way as Azure —
    # but we can test the interface default by calling it via the base path.
    # Use a minimal provider that only implements complete() and embed()
    # to verify the base chat() delegates correctly.

    class MinimalProvider(LLMProvider):
        def __init__(self):
            self.complete_calls: list[str] = []

        async def complete(self, prompt: str, tier: LLMTier) -> str:
            self.complete_calls.append(prompt)
            return "flat response"

        async def embed(self, text: str) -> list[float]:
            return []

    p = MinimalProvider()
    result = await p.chat(messages, LLMTier.AGENT_CHAT)

    assert result == "flat response"
    assert len(p.complete_calls) == 1
    # Flattened format should include role labels
    assert "[system]:" in p.complete_calls[0]
    assert "[user]:" in p.complete_calls[0]
    assert "You are an agent." in p.complete_calls[0]


# ---------------------------------------------------------------------------
# Tests: LLMTier new values
# ---------------------------------------------------------------------------


def test_llm_tier_new_values():
    """New tier values must exist with the correct integer assignments."""
    from quorum_llm.models import LLMTier

    assert LLMTier.AGENT_CHAT == 21
    assert LLMTier.AGENT_REASON == 31
    # AGENT_CHAT and AGENT_REASON are logically sub-tiers of T2/T3 respectively.
    # They use the same model deployments but are tracked separately for cost
    # accounting.  Numerically they are greater than SYNTHESIS (3) by design —
    # the sub-values (21, 31) avoid colliding with future primary tiers while
    # still being comparable with < / >.
    assert LLMTier.CONFLICT < LLMTier.SYNTHESIS < LLMTier.AGENT_CHAT < LLMTier.AGENT_REASON


def test_llm_tier_existing_values_unchanged():
    """Adding new tiers must not change existing tier values."""
    from quorum_llm.models import LLMTier

    assert LLMTier.KEYWORD == 1
    assert LLMTier.CONFLICT == 2
    assert LLMTier.SYNTHESIS == 3
