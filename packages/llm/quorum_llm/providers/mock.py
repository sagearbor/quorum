"""Mock LLM provider for testing — deterministic responses, no API calls.

Returns realistic clinical trial content keyed by input hash so tests
are fully reproducible without network access.
"""

from __future__ import annotations

import hashlib
import json
import uuid

from quorum_llm.interface import LLMProvider
from quorum_llm.models import LLMTier
from quorum_llm.tier1 import extract_keywords

# ---------------------------------------------------------------------------
# Pre-canned responses for deterministic testing
# ---------------------------------------------------------------------------

_TIER2_CONFLICT_RESPONSES: dict[str, dict] = {
    "default_conflict": {
        "has_conflict": True,
        "description": (
            "The Principal Investigator recommends a 12-week dosing interval "
            "while the IRB requires a 6-week safety review checkpoint. "
            "Higher-authority role (IRB, rank 3) overrides on safety matters."
        ),
        "severity": "high",
    },
    "default_no_conflict": {
        "has_conflict": False,
        "description": "All contributions align on the proposed protocol timeline.",
        "severity": "low",
    },
}

_TIER3_ARTIFACT_SECTIONS: list[dict[str, str]] = [
    {
        "title": "Protocol Summary",
        "content": (
            "Multi-site Phase II clinical trial (NCT-MOCK-2026-001) evaluating "
            "the efficacy of compound QRM-42 in treatment-resistant hypertension. "
            "Primary endpoint: reduction in systolic blood pressure at 24 weeks. "
            "Enrollment target: 240 participants across 6 DCRI-affiliated sites."
        ),
    },
    {
        "title": "Safety & Monitoring",
        "content": (
            "Independent Data Safety Monitoring Board (DSMB) review at weeks 6, "
            "12, and 18. Stopping rules: >15% serious adverse event rate triggers "
            "automatic enrollment pause. IRB oversight with expedited reporting "
            "for any Grade 3+ adverse events within 72 hours."
        ),
    },
    {
        "title": "Stakeholder Consensus",
        "content": (
            "All contributing roles reached consensus on primary endpoint "
            "selection. The IRB-recommended 6-week safety checkpoints were "
            "adopted over the PI's proposed 12-week interval, per authority "
            "hierarchy. Biostatistics confirmed adequate power (0.82) at the "
            "revised sample size of 240."
        ),
    },
    {
        "title": "Resource Allocation",
        "content": (
            "Budget allocation: 45% clinical operations, 25% site payments, "
            "15% data management, 10% regulatory, 5% contingency. "
            "Estimated timeline: 18 months enrollment, 6 months follow-up, "
            "4 months analysis and reporting."
        ),
    },
]

# Conflict detection prompt response when there IS a conflict
_CONFLICT_YES = json.dumps(_TIER2_CONFLICT_RESPONSES["default_conflict"])
# Conflict detection prompt response when there is NO conflict
_CONFLICT_NO = json.dumps(_TIER2_CONFLICT_RESPONSES["default_no_conflict"])
# Artifact synthesis response
_ARTIFACT_JSON = json.dumps(_TIER3_ARTIFACT_SECTIONS)


def _hash_key(text: str) -> str:
    """Produce a short hash key from input text."""
    return hashlib.sha256(text.encode()).hexdigest()[:12]


class MockLLMProvider(LLMProvider):
    """Deterministic mock provider for testing.

    - Tier 1: delegates to real keyword extraction (no API call)
    - Tier 2: returns conflict/no-conflict based on prompt content
    - Tier 3: returns realistic clinical trial artifact sections
    - embed: returns a deterministic vector derived from input hash
    """

    def __init__(self) -> None:
        self.call_log: list[dict] = []

    async def complete(self, prompt: str, tier: LLMTier) -> str:
        self.call_log.append({"prompt_hash": _hash_key(prompt), "tier": int(tier)})

        if tier == LLMTier.KEYWORD:
            return ", ".join(extract_keywords(prompt))

        if tier == LLMTier.CONFLICT:
            # Detect conflict based on whether there are multiple contribution
            # lines from different roles (the structural signal, not keywords).
            contrib_lines = [l for l in prompt.split("\n") if l.strip().startswith("- [")]
            if len(contrib_lines) >= 2:
                return _CONFLICT_YES
            return _CONFLICT_NO

        if tier in (LLMTier.AGENT_CHAT, LLMTier.AGENT_RESPOND, LLMTier.AGENT_REASON):
            # Return a realistic facilitator acknowledgement for agent turns.
            return (
                "Understood. I have reviewed the current documents and the "
                "incoming request. I note a potential concern around the "
                "enrollment timeline and will flag it for the safety monitor. "
                "[tags: enrollment, timeline, safety_monitoring]"
            )

        # Tier SYNTHESIS (3) — artifact synthesis
        return _ARTIFACT_JSON

    async def chat(
        self,
        messages: list[dict[str, str]],
        tier: LLMTier,
        temperature: float = 0.4,
        max_tokens: int = 1024,
    ) -> str:
        """Chat completion — records the call and delegates to complete().

        The mock flattens the messages array so the existing call_log format
        (prompt_hash, tier) stays consistent across complete() and chat().
        """
        flat = "\n".join(f"[{m['role']}]: {m['content']}" for m in messages)
        return await self.complete(flat, tier)

    async def respond(
        self,
        instructions: str,
        input_text: str,
        tier: LLMTier,
        reasoning_effort: str = "medium",
        previous_response_id: str | None = None,
    ) -> tuple[str, str | None]:
        """Responses API mock — deterministic reply + synthetic response_id.

        Simulates the GPT-5 Responses API for testing.  Returns a canned
        facilitator acknowledgement and a fake UUID-based response_id so
        callers can verify stateful threading without a real API connection.

        The call is recorded in call_log with tier=AGENT_RESPOND and an
        additional ``reasoning_effort`` field for assertion in tests.
        """
        combo = f"{instructions[:40]}|{input_text[:40]}|{reasoning_effort}"
        self.call_log.append({
            "prompt_hash": _hash_key(combo),
            "tier": int(tier),
            "reasoning_effort": reasoning_effort,
            "previous_response_id": previous_response_id,
        })

        response_text = (
            "I have carefully considered the current documents and the "
            "incoming request using enhanced reasoning. My assessment "
            "focuses on enrollment timeline risks and safety thresholds. "
            "[tags: enrollment, timeline, safety_monitoring, reasoning]"
        )
        # Generate a deterministic but unique-looking response ID based on input
        fake_response_id = f"resp_{_hash_key(combo)}_{str(uuid.uuid4())[:8]}"
        return response_text, fake_response_id

    async def embed(self, text: str) -> list[float]:
        self.call_log.append({"prompt_hash": _hash_key(text), "tier": "embed"})
        # Deterministic 256-dim vector from hash
        h = hashlib.sha256(text.encode()).digest()
        # Use hash bytes to seed a reproducible vector
        vec = [((b % 200) - 100) / 100.0 for b in h]
        # Pad to 256 dimensions by cycling
        while len(vec) < 256:
            vec.extend(vec)
        return vec[:256]
