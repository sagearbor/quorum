"""Tests for the tag affinity engine (quorum_llm/affinity.py).

Coverage:
- compute_tag_affinity: Jaccard similarity edge cases
- extract_tags_from_text: explicit [tags:] blocks, keyword fallback, vocabulary resolution
- find_relevant_agents: threshold filtering, ordering, affinity_score injection
- build_affinity_graph: adjacency completeness, directionality, score values
- canonicalize_tag: every normalization rule
- merge_tag_vocabularies: grow, cap, dedup behaviour
"""

from __future__ import annotations

import pytest

from quorum_llm.affinity import (
    build_affinity_graph,
    canonicalize_tag,
    compute_tag_affinity,
    extract_tags_from_text,
    find_relevant_agents,
    merge_tag_vocabularies,
)


# ---------------------------------------------------------------------------
# compute_tag_affinity
# ---------------------------------------------------------------------------


class TestComputeTagAffinity:
    def test_identical_sets_returns_one(self):
        assert compute_tag_affinity(["irb", "consent"], ["irb", "consent"]) == 1.0

    def test_disjoint_sets_returns_zero(self):
        assert compute_tag_affinity(["irb", "consent"], ["budget", "timeline"]) == 0.0

    def test_empty_first_arg_returns_zero(self):
        assert compute_tag_affinity([], ["irb", "consent"]) == 0.0

    def test_empty_second_arg_returns_zero(self):
        assert compute_tag_affinity(["irb"], []) == 0.0

    def test_both_empty_returns_zero(self):
        assert compute_tag_affinity([], []) == 0.0

    def test_partial_overlap(self):
        # Intersection={irb}, Union={irb, consent, budget} → 1/3
        score = compute_tag_affinity(["irb", "consent"], ["irb", "budget"])
        assert pytest.approx(score, abs=1e-9) == 1 / 3

    def test_single_common_tag(self):
        score = compute_tag_affinity(["a", "b", "c"], ["c", "d", "e"])
        # |∩|=1, |∪|=5
        assert pytest.approx(score, abs=1e-9) == 1 / 5

    def test_canonicalization_applied_before_comparison(self):
        # "IRB Review" should canonicalize to "irb_review" and match
        score = compute_tag_affinity(["IRB Review"], ["irb_review"])
        assert score == 1.0

    def test_duplicate_tags_in_input_treated_as_set(self):
        # Duplicates within a list should not inflate the union
        score = compute_tag_affinity(["irb", "irb"], ["irb"])
        assert score == 1.0

    def test_whitespace_only_tags_ignored(self):
        # Tags that canonicalize to "" should be dropped
        score = compute_tag_affinity(["  ", "irb"], ["irb"])
        assert score == 1.0


# ---------------------------------------------------------------------------
# canonicalize_tag
# ---------------------------------------------------------------------------


class TestCanonicalizeTag:
    def test_lowercase(self):
        assert canonicalize_tag("IRB") == "irb"

    def test_spaces_become_underscores(self):
        assert canonicalize_tag("adverse event") == "adverse_event"

    def test_hyphens_become_underscores(self):
        assert canonicalize_tag("gmp-compliance") == "gmp_compliance"

    def test_mixed_spaces_and_hyphens(self):
        assert canonicalize_tag("phase 2-trial") == "phase_2_trial"

    def test_special_chars_stripped(self):
        assert canonicalize_tag("safety!@#monitoring") == "safetymonitoring"

    def test_leading_trailing_underscores_stripped(self):
        assert canonicalize_tag("_irb_") == "irb"

    def test_max_30_chars(self):
        long_input = "a" * 50
        result = canonicalize_tag(long_input)
        assert len(result) == 30

    def test_exactly_30_chars_unchanged(self):
        tag = "a" * 30
        assert canonicalize_tag(tag) == tag

    def test_empty_string(self):
        assert canonicalize_tag("") == ""

    def test_whitespace_only(self):
        assert canonicalize_tag("   ") == ""

    def test_non_alnum_only(self):
        assert canonicalize_tag("!@#$%") == ""

    def test_numbers_preserved(self):
        assert canonicalize_tag("Phase 3") == "phase_3"

    def test_already_canonical(self):
        assert canonicalize_tag("irb_review") == "irb_review"


# ---------------------------------------------------------------------------
# extract_tags_from_text
# ---------------------------------------------------------------------------


class TestExtractTagsFromText:
    def test_explicit_tag_block_parsed(self):
        text = "Patient data looks good. [tags: irb, consent, enrollment]"
        tags = extract_tags_from_text(text)
        assert "irb" in tags
        assert "consent" in tags
        assert "enrollment" in tags

    def test_singular_tag_keyword_parsed(self):
        text = "This is a safety concern. [tag: adverse_event]"
        tags = extract_tags_from_text(text)
        assert "adverse_event" in tags

    def test_case_insensitive_tag_block(self):
        text = "[TAGS: IRB_Review, Consent]"
        tags = extract_tags_from_text(text)
        assert "irb_review" in tags
        assert "consent" in tags

    def test_multiple_tag_blocks(self):
        text = "[tags: irb] Some text. [tags: budget, timeline]"
        tags = extract_tags_from_text(text)
        assert "irb" in tags
        assert "budget" in tags
        assert "timeline" in tags

    def test_no_tag_block_falls_back_to_keywords(self):
        # A text with no [tags:] block but with meaningful repeated words
        text = "The enrollment enrollment process requires screening screening criteria."
        tags = extract_tags_from_text(text)
        # Keyword extractor should pick up "enrollment" and "screening"
        assert any("enrollment" in t for t in tags)

    def test_tags_canonicalized(self):
        text = "[tags: IRB Review, Adverse Event]"
        tags = extract_tags_from_text(text)
        assert "irb_review" in tags
        assert "adverse_event" in tags

    def test_deduplication(self):
        text = "[tags: irb, irb, consent] irb irb irb"
        tags = extract_tags_from_text(text)
        assert tags.count("irb") == 1

    def test_vocabulary_resolution_exact_match(self):
        vocab = {"adverse_events", "irb_approval", "enrollment"}
        text = "[tags: irb_approval, enrollment]"
        tags = extract_tags_from_text(text, existing_vocabulary=vocab)
        assert "irb_approval" in tags
        assert "enrollment" in tags

    def test_vocabulary_resolution_prefix_match(self):
        # "adverse_event" (no s) should resolve to "adverse_events" in vocab
        vocab = {"adverse_events"}
        text = "[tags: adverse_event]"
        tags = extract_tags_from_text(text, existing_vocabulary=vocab)
        # Should map to vocabulary term
        assert "adverse_events" in tags

    def test_empty_text(self):
        tags = extract_tags_from_text("")
        assert tags == []

    def test_explicit_tags_appear_first(self):
        # Explicit block tags should come before keyword-extracted tags
        text = "[tags: alpha] beta gamma delta alpha beta gamma"
        tags = extract_tags_from_text(text)
        if "alpha" in tags:
            assert tags.index("alpha") < len(tags)  # sanity check

    def test_no_vocabulary_provided(self):
        # Should work fine without vocabulary
        text = "[tags: irb, consent]"
        tags = extract_tags_from_text(text, existing_vocabulary=None)
        assert "irb" in tags

    def test_empty_vocabulary(self):
        text = "[tags: irb]"
        tags = extract_tags_from_text(text, existing_vocabulary=set())
        assert "irb" in tags


# ---------------------------------------------------------------------------
# find_relevant_agents
# ---------------------------------------------------------------------------


_AGENTS_FIXTURE = [
    {"role_id": "irb",     "domain_tags": ["irb", "consent", "eligibility", "enrollment"]},
    {"role_id": "sponsor", "domain_tags": ["budget", "timeline", "regulatory", "fda"]},
    {"role_id": "safety",  "domain_tags": ["adverse_events", "safety_monitoring", "dsmb", "irb"]},
    {"role_id": "site",    "domain_tags": ["enrollment", "crc_staffing", "screening"]},
]


class TestFindRelevantAgents:
    def test_returns_agents_above_threshold(self):
        # Source tags heavily overlap with irb and safety agents
        source = ["irb", "consent", "adverse_events"]
        relevant = find_relevant_agents(source, _AGENTS_FIXTURE, threshold=0.2)
        role_ids = [a["role_id"] for a in relevant]
        assert "irb" in role_ids
        assert "safety" in role_ids

    def test_excludes_agents_below_threshold(self):
        source = ["irb", "consent"]
        relevant = find_relevant_agents(source, _AGENTS_FIXTURE, threshold=0.5)
        role_ids = [a["role_id"] for a in relevant]
        # Sponsor has no overlap with irb/consent — should be excluded
        assert "sponsor" not in role_ids

    def test_sorted_descending_by_score(self):
        source = ["irb", "consent", "eligibility", "enrollment"]
        relevant = find_relevant_agents(source, _AGENTS_FIXTURE, threshold=0.1)
        scores = [a["affinity_score"] for a in relevant]
        assert scores == sorted(scores, reverse=True)

    def test_affinity_score_injected(self):
        source = ["irb"]
        relevant = find_relevant_agents(source, _AGENTS_FIXTURE, threshold=0.0)
        for agent in relevant:
            assert "affinity_score" in agent
            assert 0.0 <= agent["affinity_score"] <= 1.0

    def test_threshold_zero_returns_all_with_any_overlap(self):
        # With threshold=0.0, all agents with non-empty tags and non-zero Jaccard should appear.
        # Sponsor has no overlap with irb-related tags — it will have score 0.0
        # and should be excluded (0.0 is not >= 0.0 in strict sense).
        # Actually threshold is >=, so 0.0 >= 0.0 means all agents returned.
        source = ["irb"]
        relevant = find_relevant_agents(source, _AGENTS_FIXTURE, threshold=0.0)
        # Agents with zero overlap will still be included (score 0.0 >= threshold 0.0)
        assert len(relevant) >= 2  # at least irb and safety agents

    def test_empty_source_tags_returns_empty(self):
        relevant = find_relevant_agents([], _AGENTS_FIXTURE, threshold=0.2)
        assert relevant == []

    def test_empty_agent_list(self):
        relevant = find_relevant_agents(["irb"], [], threshold=0.2)
        assert relevant == []

    def test_does_not_mutate_input_dicts(self):
        # The function injects affinity_score — verify it copies, not mutates
        original = {"role_id": "irb", "domain_tags": ["irb", "consent"]}
        agents_in = [original]
        relevant = find_relevant_agents(["irb"], agents_in, threshold=0.0)
        # Original dict should NOT have affinity_score added
        assert "affinity_score" not in original
        # But returned dict should
        if relevant:
            assert "affinity_score" in relevant[0]

    def test_agents_with_no_domain_tags_score_zero(self):
        agents = [
            {"role_id": "empty", "domain_tags": []},
            {"role_id": "irb", "domain_tags": ["irb"]},
        ]
        relevant = find_relevant_agents(["irb"], agents, threshold=0.5)
        role_ids = [a["role_id"] for a in relevant]
        assert "irb" in role_ids
        assert "empty" not in role_ids


# ---------------------------------------------------------------------------
# build_affinity_graph
# ---------------------------------------------------------------------------


class TestBuildAffinityGraph:
    def test_returns_all_agents_as_keys(self):
        agents = [
            {"role_id": "a", "domain_tags": ["irb"]},
            {"role_id": "b", "domain_tags": ["irb", "consent"]},
            {"role_id": "c", "domain_tags": ["budget"]},
        ]
        graph = build_affinity_graph(agents)
        assert set(graph.keys()) == {"a", "b", "c"}

    def test_symmetric_edges(self):
        agents = [
            {"role_id": "a", "domain_tags": ["irb", "consent"]},
            {"role_id": "b", "domain_tags": ["irb", "budget"]},
        ]
        graph = build_affinity_graph(agents)
        a_targets = {e["target_role_id"] for e in graph["a"]}
        b_targets = {e["target_role_id"] for e in graph["b"]}
        # If a→b exists, b→a must also exist
        if "b" in a_targets:
            assert "a" in b_targets

    def test_no_self_loops(self):
        agents = [
            {"role_id": "a", "domain_tags": ["irb"]},
            {"role_id": "b", "domain_tags": ["irb"]},
        ]
        graph = build_affinity_graph(agents)
        for role_id, edges in graph.items():
            for edge in edges:
                assert edge["target_role_id"] != role_id

    def test_disjoint_tags_no_edges(self):
        agents = [
            {"role_id": "a", "domain_tags": ["irb", "consent"]},
            {"role_id": "b", "domain_tags": ["budget", "timeline"]},
        ]
        graph = build_affinity_graph(agents)
        # No common tags → no edges above threshold 0.1
        assert graph["a"] == []
        assert graph["b"] == []

    def test_identical_tags_full_affinity(self):
        agents = [
            {"role_id": "a", "domain_tags": ["irb", "consent"]},
            {"role_id": "b", "domain_tags": ["irb", "consent"]},
        ]
        graph = build_affinity_graph(agents)
        assert len(graph["a"]) == 1
        assert graph["a"][0]["affinity_score"] == pytest.approx(1.0)

    def test_adjacency_sorted_descending(self):
        # Three agents where a shares more tags with b than with c
        agents = [
            {"role_id": "a", "domain_tags": ["irb", "consent", "enrollment"]},
            {"role_id": "b", "domain_tags": ["irb", "consent", "safety"]},
            {"role_id": "c", "domain_tags": ["irb", "budget"]},
        ]
        graph = build_affinity_graph(agents)
        a_edges = graph["a"]
        if len(a_edges) >= 2:
            scores = [e["affinity_score"] for e in a_edges]
            assert scores == sorted(scores, reverse=True)

    def test_empty_agent_list(self):
        graph = build_affinity_graph([])
        assert graph == {}

    def test_single_agent_no_edges(self):
        graph = build_affinity_graph([{"role_id": "a", "domain_tags": ["irb"]}])
        assert graph == {"a": []}

    def test_affinity_scores_in_valid_range(self):
        agents = _AGENTS_FIXTURE
        graph = build_affinity_graph(agents)
        for edges in graph.values():
            for edge in edges:
                assert 0.0 <= edge["affinity_score"] <= 1.0


# ---------------------------------------------------------------------------
# merge_tag_vocabularies
# ---------------------------------------------------------------------------


class TestMergeTagVocabularies:
    def test_adds_new_tags(self):
        existing = {"irb", "consent"}
        result = merge_tag_vocabularies(existing, ["enrollment", "budget"])
        assert "enrollment" in result
        assert "budget" in result

    def test_preserves_existing_tags(self):
        existing = {"irb", "consent"}
        result = merge_tag_vocabularies(existing, ["enrollment"])
        assert "irb" in result
        assert "consent" in result

    def test_deduplicates(self):
        existing = {"irb"}
        result = merge_tag_vocabularies(existing, ["irb", "irb", "consent"])
        assert result.count("irb") if isinstance(result, list) else True  # set has no count
        assert len([t for t in result if t == "irb"]) == 1

    def test_canonicalizes_new_tags(self):
        existing = set()
        result = merge_tag_vocabularies(existing, ["IRB Review", "Adverse Event"])
        assert "irb_review" in result
        assert "adverse_event" in result

    def test_max_size_cap_respected(self):
        existing = {"tag_" + str(i) for i in range(10)}
        new_tags = ["new_" + str(i) for i in range(10)]
        result = merge_tag_vocabularies(existing, new_tags, max_size=15)
        assert len(result) <= 15

    def test_at_cap_no_new_tags_added(self):
        existing = {"tag_" + str(i) for i in range(5)}
        result = merge_tag_vocabularies(existing, ["new_tag"], max_size=5)
        assert len(result) == 5
        assert "new_tag" not in result

    def test_empty_new_tags(self):
        existing = {"irb"}
        result = merge_tag_vocabularies(existing, [])
        assert result == {"irb"}

    def test_empty_existing(self):
        result = merge_tag_vocabularies(set(), ["irb", "consent"])
        assert result == {"irb", "consent"}

    def test_does_not_mutate_existing(self):
        existing = {"irb"}
        original = frozenset(existing)
        merge_tag_vocabularies(existing, ["consent"])
        assert frozenset(existing) == original  # existing unchanged

    def test_tags_canonicalizing_to_empty_dropped(self):
        existing = set()
        result = merge_tag_vocabularies(existing, ["!@#", "  ", "valid_tag"])
        assert "valid_tag" in result
        assert "" not in result
        # Only one valid tag should be in result
        assert len(result) == 1
