"""Per-quorum tag vocabulary — in-memory registry that grows as agents produce tags.

The vocabulary serves two purposes:

1. **Consistency**: When a new agent joins (or when any agent extracts tags from
   text), providing the current vocabulary allows ``affinity.extract_tags_from_text``
   to map novel tokens to established terms rather than fragmenting the tag space.

2. **Discovery**: The growing vocabulary is a lightweight signal about what topics
   are active in a quorum.  It is included in new-agent context so they can
   immediately participate in tag-based affinity routing.

State is stored as a plain in-memory dict keyed by ``quorum_id``.  This is
intentionally simple: the vocabulary is re-derivable from the tags stored on
``agent_insights`` and ``station_messages`` rows if the process restarts.  It is
not a source of truth — only a performance cache to avoid repeated DB scans.

Thread safety: CPython's GIL makes individual dict operations atomic enough for
the access patterns here (FastAPI event loop is single-threaded by default).
If concurrency requirements change, replace ``_store`` with a ``threading.Lock``-
guarded structure or migrate to a shared cache (Redis, Supabase KV).

Usage example::

    from apps.api.tag_vocabulary import get_vocabulary, update_vocabulary

    # At agent startup: load vocabulary so tag extraction is vocabulary-aware
    vocab = get_vocabulary(quorum_id)

    # After an agent publishes an insight with new tags
    update_vocabulary(quorum_id, new_tags=["egfr_threshold", "dsmb_review"])
"""

from __future__ import annotations

import logging
import threading

from quorum_llm.affinity import canonicalize_tag, merge_tag_vocabularies

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

# vocabulary store: quorum_id → set of canonical tag strings
_store: dict[str, set[str]] = {}

# Per-quorum vocabulary size cap.  Keeps memory bounded on long-running quorums.
_MAX_VOCAB_SIZE = 500

# Lock for thread-safe access to _store (defensive even in single-threaded env)
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_vocabulary(quorum_id: str) -> set[str]:
    """Return the current tag vocabulary for a quorum.

    Returns an empty set for quorums not yet seen.  Never raises.
    The returned set is a shallow copy — callers may not mutate it to avoid
    accidentally bypassing the size cap.

    Args:
        quorum_id: Quorum identifier.

    Returns:
        Frozenish copy of the current vocabulary set.
    """
    with _lock:
        return set(_store.get(quorum_id, set()))


def update_vocabulary(quorum_id: str, new_tags: list[str]) -> int:
    """Add new tags to the quorum vocabulary, capping at _MAX_VOCAB_SIZE.

    Tags are canonicalized before insertion.  Already-present tags are
    silently skipped.  Returns the number of net-new tags actually added.

    This is a write-through operation — it updates the in-memory store only.
    Persisting the vocabulary to Supabase (if desired) is the caller's
    responsibility.

    Args:
        quorum_id: Quorum identifier.
        new_tags:  List of raw or canonical tag strings to add.

    Returns:
        Number of new distinct tags added to the vocabulary.
    """
    if not new_tags:
        return 0

    with _lock:
        existing = _store.get(quorum_id, set())
        before = len(existing)
        updated = merge_tag_vocabularies(existing, new_tags, max_size=_MAX_VOCAB_SIZE)
        added = len(updated) - before
        _store[quorum_id] = updated

    if added:
        logger.debug(
            "tag_vocabulary: quorum=%s added %d tags (vocab size now %d)",
            quorum_id,
            added,
            len(_store[quorum_id]),
        )
    return added


def seed_vocabulary(quorum_id: str, tags: list[str]) -> None:
    """Seed a quorum vocabulary from a known domain tag list.

    Intended to be called at quorum creation time with the architect-provided
    domain tags from ``agent_configs``.  Unlike ``update_vocabulary``, this
    replaces any existing vocabulary for the quorum (a deliberate reset).

    Args:
        quorum_id: Quorum identifier.
        tags:      Seed tags (canonicalized automatically).
    """
    canonical_tags = [canonicalize_tag(t) for t in tags]
    canonical_tags = [t for t in canonical_tags if t]

    with _lock:
        _store[quorum_id] = merge_tag_vocabularies(
            set(),  # start fresh
            canonical_tags,
            max_size=_MAX_VOCAB_SIZE,
        )

    logger.info(
        "tag_vocabulary: seeded quorum=%s with %d tags",
        quorum_id,
        len(_store.get(quorum_id, set())),
    )


def clear_vocabulary(quorum_id: str) -> None:
    """Remove the vocabulary for a quorum (used in tests or quorum teardown).

    Args:
        quorum_id: Quorum identifier.
    """
    with _lock:
        _store.pop(quorum_id, None)


def vocabulary_size(quorum_id: str) -> int:
    """Return the current vocabulary size for a quorum.

    Returns 0 for unknown quorums.

    Args:
        quorum_id: Quorum identifier.
    """
    with _lock:
        return len(_store.get(quorum_id, set()))
