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

    # Varied responses keyed by role-like keywords found in the prompt.
    # Each list is cycled through using prompt hash so different turns get different text.
    _ROLE_RESPONSES: dict[str, list[str]] = {
        "researcher": [
            "Based on the available evidence, I recommend we gather baseline data before proceeding. The current approach lacks rigorous methodology for measuring outcomes. I suggest a mixed-methods design combining quantitative metrics with qualitative stakeholder interviews. [tags: research, methodology, evidence]",
            "I've reviewed the literature on similar interventions. Key finding: shared governance models show 40% better faculty satisfaction scores. We should benchmark against peer institutions. [tags: research, benchmarking, governance]",
            "The data suggests a systemic issue rather than individual leadership failure. I recommend a root cause analysis framework — specifically the Ishikawa diagram approach for educational governance. [tags: research, root_cause, systems_thinking]",
        ],
        "ethicist": [
            "This raises significant concerns about power concentration and lack of checks and balances. Faculty autonomy is a core principle of academic governance. Any solution must preserve academic freedom while ensuring accountability. [tags: ethics, autonomy, governance]",
            "I want to flag a fairness concern: if one person controls all curriculum decisions, there's inherent bias risk. We need transparent decision-making criteria and an appeals process. [tags: ethics, fairness, transparency]",
            "From an ethical standpoint, the affected faculty deserve voice in this process. I recommend establishing a faculty senate subcommittee with real decision-making authority, not just advisory capacity. [tags: ethics, representation, due_process]",
        ],
        "administrator": [
            "From an operational perspective, we need to define clear roles and responsibilities. A RACI matrix would help delineate who is Responsible, Accountable, Consulted, and Informed for each curriculum decision. [tags: operations, governance, RACI]",
            "I've drafted a proposed organizational structure that distributes curriculum authority across three committees: content review, assessment, and clinical integration. Each reports to the dean but has autonomous decision-making within scope. [tags: operations, structure, delegation]",
            "Budget implications: transitioning to shared governance requires investment in committee infrastructure — roughly 0.2 FTE per committee chair. However, this reduces bottleneck risk and improves throughput on curriculum changes by an estimated 60%. [tags: operations, budget, efficiency]",
        ],
        "patient_advocate": [
            "The students and trainees are the ones ultimately affected by curriculum decisions. Their learning outcomes should be our north star metric. I recommend incorporating student feedback mechanisms into any governance reform. [tags: advocacy, student_outcomes, feedback]",
            "I want to ensure we don't lose sight of patient safety implications. Curriculum quality directly impacts clinical competency. Any governance change must include quality assurance checkpoints. [tags: advocacy, patient_safety, quality]",
            "Speaking for the affected community: faculty morale is at a critical low. Three department chairs have expressed intent to leave if governance doesn't change. We need interim measures while long-term solutions develop. [tags: advocacy, retention, urgency]",
        ],
    }

    _GENERIC_RESPONSES: list[str] = [
        "I've analyzed the current situation and identified three priority areas. First, we need better communication channels between stakeholders. Second, decision-making authority should be distributed. Third, we need measurable outcomes to track progress. [tags: analysis, priorities, governance]",
        "Building on what other agents have shared, I see an opportunity for a phased approach: immediate conflict resolution in month one, structural reforms in months two through three, and evaluation in month four. [tags: planning, timeline, phased_approach]",
        "I'd like to flag a potential conflict between the efficiency goals and the equity goals raised by others. We should explicitly prioritize — I recommend equity first, then optimize for efficiency within those constraints. [tags: conflict, priorities, tradeoffs]",
    ]

    def __init__(self) -> None:
        self.call_log: list[dict] = []
        self._turn_counter: int = 0

    def _varied_agent_response(self, prompt: str) -> str:
        """Generate varied mock responses based on role keywords in the prompt."""
        prompt_lower = prompt.lower()
        self._turn_counter += 1

        # Find the best matching role
        for role_key, responses in self._ROLE_RESPONSES.items():
            if role_key in prompt_lower:
                idx = (int(_hash_key(prompt), 16) + self._turn_counter) % len(responses)
                return responses[idx]

        # Generic fallback with rotation
        idx = self._turn_counter % len(self._GENERIC_RESPONSES)
        return self._GENERIC_RESPONSES[idx]

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
            # Generate varied responses based on prompt content hash
            return self._varied_agent_response(prompt)

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
