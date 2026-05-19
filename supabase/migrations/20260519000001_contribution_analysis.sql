-- Per-contribution LLM analysis: store the Tier-2 analyzer output alongside
-- each contribution row.  Three columns:
--
--   analysis_tags      — LLM-extracted snake_case domain tags (3-10 entries).
--                        Replaces the stopword-based tier1.extract_keywords
--                        output for contribution flow specifically (Sophie's
--                        expo feedback: "while", "introduction", "refined"
--                        were polluting the chart pills).
--
--   analysis_deltas    — Per-metric score impact emitted by the analyzer.
--                        Keys: consensus, completion, critical_path, blockers,
--                        role_coverage.  Each value clamped to [-20, +20] at
--                        the application layer (see packages/llm/
--                        quorum_llm/contribution_analyzer.py).
--
--   analysis_rationale — Plain-English 1-2 sentence audit-trail string,
--                        surfaced in the chart hover popover.
--
-- The GIN index supports tag-affinity queries that filter contributions by
-- analysis_tags (used by the affinity graph dashboards).
ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS analysis_tags text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS analysis_deltas jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS analysis_rationale text;

CREATE INDEX IF NOT EXISTS idx_contributions_analysis_tags
  ON contributions USING GIN (analysis_tags);
