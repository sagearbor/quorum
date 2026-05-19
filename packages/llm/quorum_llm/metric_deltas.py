"""LLM-driven metric delta parser.

Each agent persona is instructed to emit an optional ``[scores: ...]`` block
alongside its reply that signals how the turn moved its read of the five
secondary health metrics. This module parses those blocks.

Format the LLM should produce::

    [scores: consensus=-10, blockers=+5, completion=+3, role_coverage=0, critical_path=+8]
    [scores-why: blockers rose because IRB raised a consent issue]

- Per-turn deltas are clamped to [-20, 20] per metric.
- Unknown metric keys are silently dropped (forward-compat: if the persona
  invents a new key, we ignore it rather than poison the chart).
- Missing keys = no change.
- Whitespace is tolerated everywhere.

The five canonical metric keys map onto the column-suffixed names exposed by
``apps/api/health.py``:

    short key       column key
    ---------       ----------
    consensus       consensus_score
    completion      completion_pct
    role_coverage   role_coverage_pct
    critical_path   critical_path_score
    blockers        blocker_score

``apply_deltas_to_running_total`` is a tiny helper that applies new deltas to
the running cumulative dict with the 20%-per-turn decay used by the agent
engine + contribute route.  It lives here so the agent_engine.py call site
stays a single function call (and so the decay logic is unit-testable in
isolation from the broader turn flow).
"""

from __future__ import annotations

import re
from typing import Optional


# ---------------------------------------------------------------------------
# Public mapping: short keys (what the LLM emits) ↔ column-suffixed keys
# (what `health.py` returns and the frontend HealthMetrics type expects).
# ---------------------------------------------------------------------------
SHORT_TO_COLUMN: dict[str, str] = {
    "consensus":     "consensus_score",
    "completion":    "completion_pct",
    "role_coverage": "role_coverage_pct",
    "critical_path": "critical_path_score",
    "blockers":      "blocker_score",
}

# Reverse lookup, used only by tests / debugging.
COLUMN_TO_SHORT: dict[str, str] = {v: k for k, v in SHORT_TO_COLUMN.items()}

# Per-turn clamp range (PER metric, PER turn).
_PER_TURN_MIN = -20.0
_PER_TURN_MAX = 20.0

# Cumulative clamp range (PER metric across the whole quorum).
CUMULATIVE_MIN = -50.0
CUMULATIVE_MAX = 50.0

# Decay factor applied each turn before new deltas are added.  0.8 means
# 20% of the existing modulation fades per turn — a blocker from 10 turns
# ago has shrunk by ~89% (0.8 ** 10).
DECAY_FACTOR = 0.8


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


def extract_score_deltas(text: str) -> tuple[dict[str, float], Optional[str]]:
    """Parse ``[scores: k=v, ...]`` and ``[scores-why: ...]`` from agent text.

    Returns
    -------
    ``(deltas, rationale)`` where:
        * ``deltas`` maps short metric keys (``consensus``, ``completion``,
          ``role_coverage``, ``critical_path``, ``blockers``) to floats
          clamped to [-20, 20].  Unknown keys are dropped silently.  When
          no ``[scores: ...]`` block is present (or none of the keys are
          recognized), returns an empty dict.
        * ``rationale`` is the free-text rationale from ``[scores-why: ...]``
          truncated to 100 chars, or ``None`` when not present.

    The function is intentionally permissive: it tolerates ``+`` prefixes,
    decimal values, missing commas/whitespace, and case-insensitive keys —
    LLMs are not deterministic about formatting.

    Parameters
    ----------
    text : str
        The full agent reply text (may include the ``[tags: ...]`` block,
        natural-language sentences, and zero or more score blocks).  Only
        the LAST ``[scores: ...]`` block is consumed when multiple appear —
        matching the convention used for tags (later blocks override).
    """
    if not text:
        return {}, None

    deltas: dict[str, float] = {}

    # --- scores block ------------------------------------------------------
    # Match [scores: ...] but NOT [scores-why: ...].  The negative lookahead
    # after `scores` prevents `[scores-why: ...]` from being parsed here.
    scores_re = re.compile(r"\[scores(?!-why)\s*:\s*([^\]]+)\]", re.IGNORECASE)
    # Use the LAST match — same convention as tag extraction (a persona may
    # echo an earlier block in passing; the final one is authoritative).
    last_match = None
    for m in scores_re.finditer(text):
        last_match = m
    if last_match is not None:
        body = last_match.group(1)
        # Split on comma OR newline OR semicolon — be permissive.
        for raw in re.split(r"[,;\n]+", body):
            raw = raw.strip()
            if not raw:
                continue
            # Split on `=` or `:` (LLMs sometimes use the latter).
            kv = re.split(r"[=:]\s*", raw, maxsplit=1)
            if len(kv) != 2:
                continue
            key, value = kv[0].strip().lower(), kv[1].strip()
            if key not in SHORT_TO_COLUMN:
                # Unknown metric — drop silently per spec.
                continue
            # Allow leading + or - and decimal values.
            try:
                num = float(value.lstrip("+"))
            except ValueError:
                continue
            # Clamp per-turn.
            if num < _PER_TURN_MIN:
                num = _PER_TURN_MIN
            elif num > _PER_TURN_MAX:
                num = _PER_TURN_MAX
            deltas[key] = num

    # --- scores-why block --------------------------------------------------
    rationale: Optional[str] = None
    why_re = re.compile(r"\[scores-why\s*:\s*([^\]]+)\]", re.IGNORECASE)
    why_match = None
    for m in why_re.finditer(text):
        why_match = m  # take the last one
    if why_match is not None:
        rationale = why_match.group(1).strip()[:100]
        if not rationale:
            rationale = None

    return deltas, rationale


# ---------------------------------------------------------------------------
# Running total accumulator
# ---------------------------------------------------------------------------


def apply_deltas_to_running_total(
    existing: dict[str, float] | None,
    new_deltas: dict[str, float],
    *,
    decay: float = DECAY_FACTOR,
    cumulative_min: float = CUMULATIVE_MIN,
    cumulative_max: float = CUMULATIVE_MAX,
) -> dict[str, float]:
    """Decay the existing accumulator and add new deltas; clamp cumulative.

    The accumulator is stored on ``quorums.llm_metric_deltas`` using short
    keys (``consensus``, ``completion``, etc.) — i.e. the same key space as
    ``extract_score_deltas`` returns.  Callers that need to apply this to
    column-keyed metrics should translate via ``SHORT_TO_COLUMN``.

    Parameters
    ----------
    existing : dict[str, float] | None
        The current running totals.  ``None`` is treated as an empty dict.
        Unknown keys are preserved (not dropped) so a future addition to
        ``SHORT_TO_COLUMN`` doesn't lose history.
    new_deltas : dict[str, float]
        Per-turn deltas from ``extract_score_deltas``; assumed already
        clamped to [-20, 20].
    decay : float
        Multiplier applied to existing values BEFORE new deltas are added.
        Default 0.8 → 20% of stored modulation fades each turn.
    cumulative_min, cumulative_max : float
        Inclusive bounds applied to each metric AFTER decay + addition.

    Returns
    -------
    A new dict (does not mutate ``existing``).
    """
    out: dict[str, float] = {}
    if existing:
        for k, v in existing.items():
            try:
                out[k] = float(v) * decay
            except (TypeError, ValueError):
                # Stored values should always be numbers, but be defensive —
                # a row hand-edited in the Supabase dashboard could land here.
                continue

    for k, v in (new_deltas or {}).items():
        out[k] = out.get(k, 0.0) + float(v)

    # Clamp cumulative.
    for k in list(out.keys()):
        if out[k] < cumulative_min:
            out[k] = cumulative_min
        elif out[k] > cumulative_max:
            out[k] = cumulative_max
        # Round to 3 decimals so JSON storage stays compact.
        out[k] = round(out[k], 3)

    return out


def append_rationale(
    existing: list[dict] | None,
    *,
    ts: str,
    deltas: dict[str, float],
    why: Optional[str],
    max_entries: int = 20,
) -> list[dict]:
    """Append one rationale entry per non-zero delta; cap to last ``max_entries``.

    Each entry is ``{"ts": iso8601, "metric": short_key, "delta": float, "why": str|None}``.
    A turn with three non-zero deltas produces three rationale rows (same ts /
    same why) so the frontend can colocate "Why:" with the specific series
    that moved.  An entry with delta=0 is omitted to keep the buffer focused
    on meaningful movement.

    Returns a new list (does not mutate ``existing``).
    """
    base: list[dict] = list(existing or [])
    for metric_key, delta in (deltas or {}).items():
        if not delta:
            continue
        base.append({
            "ts": ts,
            "metric": metric_key,
            "delta": round(float(delta), 3),
            "why": why,
        })

    if len(base) > max_entries:
        base = base[-max_entries:]
    return base
