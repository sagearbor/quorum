"""Tests for Tier 1: deterministic keyword extraction and dedup."""

from quorum_llm.tier1 import (
    deduplicate_contributions,
    extract_keywords,
    extract_keywords_from_fields,
    find_overlapping_fields,
)


def test_extract_keywords_basic():
    text = "The patient reported severe headache and nausea after taking medication"
    keywords = extract_keywords(text)
    assert "patient" in keywords
    assert "severe" in keywords
    assert "headache" in keywords
    # Stop words excluded
    assert "the" not in keywords
    assert "and" not in keywords


def test_extract_keywords_frequency():
    text = "safety safety safety efficacy efficacy cost"
    keywords = extract_keywords(text)
    assert keywords[0] == "safety"
    assert keywords[1] == "efficacy"


def test_extract_keywords_max_limit():
    text = "word1 word2 word3 word4 word5 word6"
    keywords = extract_keywords(text, max_keywords=3)
    assert len(keywords) <= 3


def test_extract_keywords_empty():
    assert extract_keywords("") == []
    assert extract_keywords("a the an") == []


def test_extract_keywords_from_fields():
    fields = {
        "diagnosis": "Patient presents with chronic migraine headaches",
        "treatment": "Recommended sumatriptan for acute episodes",
        "empty_field": "",
    }
    result = extract_keywords_from_fields(fields)
    assert "diagnosis" in result
    assert "treatment" in result
    assert "empty_field" not in result
    assert "patient" in result["diagnosis"]


def test_deduplicate_identical():
    contents = [
        "The patient has severe headache and nausea",
        "The patient has severe headache and nausea",
        "Completely different topic about budget allocation",
    ]
    unique = deduplicate_contributions(contents, threshold=0.6)
    assert len(unique) == 2
    assert 0 in unique
    assert 2 in unique


def test_deduplicate_similar():
    contents = [
        "Patient reports severe headache migraine nausea",
        "Patient reports bad headache migraine vomiting nausea",
        "Budget allocation for fiscal year review",
    ]
    unique = deduplicate_contributions(contents, threshold=0.6)
    # First two are very similar — second should be deduped
    assert len(unique) == 2


def test_deduplicate_all_unique():
    contents = [
        "Clinical trial safety analysis results",
        "Budget allocation for next quarter",
        "Patient enrollment targets for sites",
    ]
    unique = deduplicate_contributions(contents, threshold=0.6)
    assert len(unique) == 3


def test_deduplicate_empty():
    assert deduplicate_contributions([]) == []
    assert deduplicate_contributions(["hello"]) == [0]


def test_find_overlapping_fields():
    fields_list = [
        {"diagnosis": "migraine", "treatment": "sumatriptan"},
        {"diagnosis": "tension headache", "notes": "followup needed"},
        {"treatment": "ibuprofen"},
    ]
    overlaps = find_overlapping_fields(fields_list)
    assert "diagnosis" in overlaps
    assert set(overlaps["diagnosis"]) == {0, 1}
    assert "treatment" in overlaps
    assert set(overlaps["treatment"]) == {0, 2}
    # "notes" only has 1 contributor — should not appear
    assert "notes" not in overlaps


def test_find_overlapping_fields_empty_values():
    fields_list = [
        {"diagnosis": "migraine", "treatment": ""},
        {"diagnosis": "tension headache", "treatment": "   "},
    ]
    overlaps = find_overlapping_fields(fields_list)
    assert "diagnosis" in overlaps
    assert "treatment" not in overlaps  # Both empty/whitespace
