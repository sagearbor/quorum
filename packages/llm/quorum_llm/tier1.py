"""Tier 1: Deterministic keyword extraction and deduplication.

No LLM calls — pure Python NLP. Runs on every contribution.
"""

from __future__ import annotations

import re
import string
from collections import Counter

# Common English stop words — kept minimal to avoid external dependency
STOP_WORDS = frozenset(
    "a an the is are was were be been being have has had do does did will would "
    "shall should may might can could am not no nor so if or but and for to of in "
    "on at by from with as it its this that these those he she they we you i my "
    "his her their our your me him them us into onto about above after before "
    "between through during without within along across against upon".split()
)

# Minimum word length for keyword consideration
MIN_WORD_LEN = 3


def _tokenize(text: str) -> list[str]:
    """Lowercase, strip punctuation, split into tokens."""
    text = text.lower()
    text = text.translate(str.maketrans("", "", string.punctuation))
    return [w for w in text.split() if len(w) >= MIN_WORD_LEN and w not in STOP_WORDS]


def extract_keywords(text: str, max_keywords: int = 10) -> list[str]:
    """Extract top keywords from text by frequency.

    Returns deduplicated keywords ordered by frequency (descending).
    """
    tokens = _tokenize(text)
    counts = Counter(tokens)
    return [word for word, _ in counts.most_common(max_keywords)]


def extract_keywords_from_fields(
    structured_fields: dict[str, str], max_per_field: int = 5
) -> dict[str, list[str]]:
    """Extract keywords per structured field."""
    return {
        field_name: extract_keywords(value, max_per_field)
        for field_name, value in structured_fields.items()
        if value.strip()
    }


def deduplicate_contributions(
    contents: list[str], threshold: float = 0.6
) -> list[int]:
    """Find near-duplicate contributions by keyword overlap.

    Returns indices of contributions that are substantially unique.
    Uses Jaccard similarity on keyword sets.
    """
    keyword_sets = [set(extract_keywords(c, max_keywords=20)) for c in contents]
    unique_indices: list[int] = []

    for i, kw_set in enumerate(keyword_sets):
        if not kw_set:
            unique_indices.append(i)
            continue
        is_dup = False
        for j in unique_indices:
            other = keyword_sets[j]
            if not other:
                continue
            intersection = len(kw_set & other)
            union = len(kw_set | other)
            if union > 0 and intersection / union >= threshold:
                is_dup = True
                break
        if not is_dup:
            unique_indices.append(i)

    return unique_indices


def find_overlapping_fields(
    contributions_fields: list[dict[str, str]],
) -> dict[str, list[int]]:
    """Identify which structured fields have contributions from multiple sources.

    Returns a mapping of field_name -> list of contribution indices that
    address that field. Fields with >=2 contributors need Tier 2 conflict detection.
    """
    field_to_contributors: dict[str, list[int]] = {}
    for i, fields in enumerate(contributions_fields):
        for field_name, value in fields.items():
            if value.strip():
                field_to_contributors.setdefault(field_name, []).append(i)
    return {k: v for k, v in field_to_contributors.items() if len(v) >= 2}
