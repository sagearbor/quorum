-- Before/After view: capture two structured snapshots per quorum so the
-- frontend can show "headline rewrite" + key-aspect diff between the group's
-- initial position (after ~3 contributions land) and their final position
-- (at /resolve time, right after Tier-3 synthesis).
--
-- Both columns hold a PositionSnapshot (see
-- packages/llm/quorum_llm/position_analyzer.py:PositionSnapshot):
--
--   {
--     "summary_sentences": ["...", "...", "..."],
--     "headline": "≤80 chars — drives the headline-rewrite visual",
--     "key_aspects": [
--       {"field": "scope", "before": "...", "after": "...",
--        "changed": true, "drivers": ["<contribution_id>", ...]}
--     ],
--     "unresolved": ["item 1", "item 2"]
--   }
--
-- Stored as jsonb so the API layer's Pydantic shape stays authoritative.
-- Nullable: initial_position is set after contribution #3, final_position at
-- /resolve.  Frontend treats absence as "still gathering data…".
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS initial_position jsonb,
  ADD COLUMN IF NOT EXISTS final_position   jsonb;
