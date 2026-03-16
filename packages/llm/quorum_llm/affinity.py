"""Tag Affinity Engine — vocabulary-aware tag extraction and agent relevance scoring.

This module provides the core primitives for the tag-based affinity system
described in PRP section 5.  All functions are pure (no I/O) so they are
trivially testable and can be called from both the FastAPI agent_engine and
any future async pipelines.

Design notes:
- Jaccard similarity is used as the primary relevance metric because it is
  O(n) to compute, symmetric, and bounded [0, 1] — easy to threshold.
- Tag canonicalization is applied consistently everywhere so that "IRB Review"
  and "irb_review" are treated as the same tag throughout the system.
- Vocabulary matching (preferred-term lookup) keeps the tag space from
  exploding: new text is mapped to the closest existing vocabulary term when
  one exists, before adding a genuinely new term.
- The affinity graph is computed once per quorum update (not per turn) and
  cached by the caller.  This module just builds it; caching is the caller's
  responsibility.
"""

from __future__ import annotations

import re
from typing import Optional

from quorum_llm.tier1 import extract_keywords


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def compute_tag_affinity(tags_a: list[str], tags_b: list[str]) -> float:
    """Jaccard similarity between two tag sets.

    Returns a float in [0.0, 1.0].  Both inputs are canonicalized before
    comparison so callers do not need to pre-normalize.

    Returns 0.0 when either set is empty (no overlap possible).

    Args:
        tags_a: First tag list.
        tags_b: Second tag list.

    Returns:
        Jaccard similarity: |A ∩ B| / |A ∪ B|, or 0.0 for empty inputs.
    """
    if not tags_a or not tags_b:
        return 0.0

    set_a = {canonicalize_tag(t) for t in tags_a if canonicalize_tag(t)}
    set_b = {canonicalize_tag(t) for t in tags_b if canonicalize_tag(t)}

    if not set_a or not set_b:
        return 0.0

    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return intersection / union


def extract_tags_from_text(
    text: str,
    existing_vocabulary: Optional[set[str]] = None,
) -> list[str]:
    """Extract and canonicalize tags from arbitrary text.

    Two-pass extraction:

    1. **Explicit tag blocks** — parses ``[tags: x, y, z]`` or ``[tag: x]``
       patterns that agents are instructed to include in their responses.
       These are treated as authoritative and always included.

    2. **Keyword extraction** — runs the deterministic tier-1 keyword
       extractor on the full text for supplementary coverage.  Resulting
       keywords are canonicalized and appended after explicit tags.

    When ``existing_vocabulary`` is provided, each extracted tag is checked
    against the vocabulary.  If a close match exists (exact string equality
    after canonicalization, or substring containment for short tokens), the
    vocabulary term is used in place of the raw extracted term.  This keeps
    the tag space stable and prevents fragmentation (e.g., "adverse_event"
    vs. "adverse_events").

    All output tags are deduplicated and canonicalized.

    Args:
        text:               Input text to extract tags from.
        existing_vocabulary: Optional set of known canonical tag strings.
                            When provided, extracted tags are mapped to the
                            closest vocabulary term where possible.

    Returns:
        Deduplicated list of canonical tag strings, explicit tags first.
    """
    vocab = existing_vocabulary or set()
    collected: list[str] = []
    seen: set[str] = set()

    # --- Pass 1: explicit [tags: ...] and [tag: ...] blocks ---
    tag_block_re = re.compile(r'\[tags?:\s*([^\]]+)\]', re.IGNORECASE)
    for match in tag_block_re.finditer(text):
        for raw in match.group(1).split(","):
            canonical = canonicalize_tag(raw)
            if canonical and canonical not in seen:
                resolved = _resolve_to_vocabulary(canonical, vocab)
                seen.add(resolved)
                collected.append(resolved)

    # --- Pass 2: keyword extraction for supplementary coverage ---
    keywords = extract_keywords(text, max_keywords=15)
    for kw in keywords:
        canonical = canonicalize_tag(kw)
        if canonical and canonical not in seen:
            resolved = _resolve_to_vocabulary(canonical, vocab)
            seen.add(resolved)
            collected.append(resolved)

    return collected


def find_relevant_agents(
    source_tags: list[str],
    all_agents: list[dict],
    threshold: float = 0.2,
) -> list[dict]:
    """Find agents whose domain_tags overlap with source_tags above threshold.

    Each agent dict must contain at minimum:
        - ``role_id``: unique identifier
        - ``domain_tags``: list of tag strings

    Agents with affinity score strictly below ``threshold`` are excluded.
    The result is sorted by affinity score descending (highest first).

    An ``affinity_score`` key is injected into each returned dict so callers
    can act on the score without recomputing it.

    Args:
        source_tags:  Tags from the source event (insight, document edit, etc.).
        all_agents:   List of agent dicts with ``role_id`` and ``domain_tags``.
        threshold:    Minimum Jaccard similarity to include an agent (default 0.2).

    Returns:
        Filtered, sorted list of agent dicts augmented with ``affinity_score``.
    """
    results: list[dict] = []

    for agent in all_agents:
        agent_tags: list[str] = agent.get("domain_tags") or []
        score = compute_tag_affinity(source_tags, agent_tags)
        if score >= threshold:
            # Return a copy so we don't mutate the caller's data
            augmented = dict(agent)
            augmented["affinity_score"] = score
            results.append(augmented)

    results.sort(key=lambda a: a["affinity_score"], reverse=True)
    return results


def build_affinity_graph(
    agents: list[dict],
) -> dict[str, list[dict]]:
    """Build an adjacency list of pairwise agent affinities.

    Computes Jaccard similarity for every unique pair of agents and returns
    an adjacency list for edges whose affinity exceeds 0.1.  The graph is
    undirected (each edge appears in both directions).

    Each agent dict must contain:
        - ``role_id``: unique identifier
        - ``domain_tags``: list of tag strings

    Args:
        agents: List of agent dicts.

    Returns:
        ``{role_id: [{target_role_id, affinity_score}, ...]}``
        Only edges with score > 0.1 are included.
    """
    # Minimum threshold below which edges are omitted to keep the graph sparse.
    _GRAPH_THRESHOLD = 0.1

    graph: dict[str, list[dict]] = {a["role_id"]: [] for a in agents}

    for i, agent_a in enumerate(agents):
        for agent_b in agents[i + 1:]:
            score = compute_tag_affinity(
                agent_a.get("domain_tags") or [],
                agent_b.get("domain_tags") or [],
            )
            if score > _GRAPH_THRESHOLD:
                graph[agent_a["role_id"]].append({
                    "target_role_id": agent_b["role_id"],
                    "affinity_score": score,
                })
                graph[agent_b["role_id"]].append({
                    "target_role_id": agent_a["role_id"],
                    "affinity_score": score,
                })

    # Sort each adjacency list by descending score for predictable ordering
    for role_id in graph:
        graph[role_id].sort(key=lambda e: e["affinity_score"], reverse=True)

    return graph


def canonicalize_tag(raw: str) -> str:
    """Normalize a raw string to canonical tag form.

    Canonical form rules:
    - Lowercase
    - Spaces and hyphens → underscores
    - Strip all characters outside [a-z0-9_]
    - Strip leading/trailing underscores
    - Truncate to 30 characters

    Returns an empty string if nothing meaningful remains after normalization.

    Args:
        raw: Any string that might represent a tag.

    Returns:
        Canonical tag string, or ``""`` if no meaningful content.
    """
    tag = raw.strip().lower()
    # Collapse spaces and hyphens into underscores
    tag = re.sub(r'[\s\-]+', '_', tag)
    # Remove disallowed characters
    tag = re.sub(r'[^a-z0-9_]', '', tag)
    # Strip surrounding underscores (artifacts of stripping punctuation)
    tag = tag.strip('_')
    # Enforce maximum length
    tag = tag[:30]
    return tag


def merge_tag_vocabularies(
    existing: set[str],
    new_tags: list[str],
    max_size: int = 500,
) -> set[str]:
    """Add new tags to the vocabulary, capping at max_size.

    New tags are canonicalized before insertion.  If the combined size would
    exceed ``max_size``, new tags are added in the order provided until the
    cap is reached — excess tags are silently dropped.  This is intentionally
    simple: the caller controls which tags arrive here (e.g., by passing only
    high-confidence tags from established agents).

    When the existing vocabulary is already at or above max_size, no new tags
    are added.

    Args:
        existing: Current vocabulary set (canonical strings).
        new_tags: Candidate tags to add (will be canonicalized).
        max_size: Maximum vocabulary size after merge.

    Returns:
        New vocabulary set (does not mutate ``existing``).
    """
    result = set(existing)  # copy so we never mutate the caller's set
    for raw in new_tags:
        if len(result) >= max_size:
            break
        canonical = canonicalize_tag(raw)
        if canonical:
            result.add(canonical)
    return result


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _resolve_to_vocabulary(canonical: str, vocabulary: set[str]) -> str:
    """Map a canonical tag to the closest vocabulary term if one exists.

    Resolution strategy (in priority order):
    1. Exact match — return the vocabulary term unchanged.
    2. The canonical tag is a prefix of a vocabulary term and the vocabulary
       term is at most 5 characters longer (e.g., "adverse_event" matches
       "adverse_events").
    3. A vocabulary term is a prefix of the canonical tag under the same
       length constraint.

    If no match is found, the canonical tag is returned as-is (it will be
    treated as a new term).

    This deliberately avoids fuzzy string matching (edit distance, phonetic
    similarity) to keep the function deterministic and O(|vocab|).

    Args:
        canonical:   Already-canonicalized tag string.
        vocabulary:  Set of known canonical vocabulary terms.

    Returns:
        Matched vocabulary term or the original ``canonical`` string.
    """
    if not vocabulary:
        return canonical

    if canonical in vocabulary:
        return canonical

    # Tolerance: allow vocabulary terms that are close plural/suffix variants
    _MAX_SUFFIX_DELTA = 5

    for vocab_term in vocabulary:
        # canonical is prefix of vocab_term (e.g., "adverse_event" → "adverse_events")
        if (
            vocab_term.startswith(canonical)
            and len(vocab_term) - len(canonical) <= _MAX_SUFFIX_DELTA
        ):
            return vocab_term

        # vocab_term is prefix of canonical (e.g., "irb" → "irb_approval")
        if (
            canonical.startswith(vocab_term)
            and len(canonical) - len(vocab_term) <= _MAX_SUFFIX_DELTA
        ):
            return vocab_term

    return canonical
