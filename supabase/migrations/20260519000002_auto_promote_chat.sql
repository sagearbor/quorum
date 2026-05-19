-- Per-quorum flag controlling whether AI agents auto-promote contribution-worthy
-- chat turns into actual contributions rows.
--
-- Why: Sophie's expo demo today shows users chatting forever while the chart
-- stays flat because chat turns only write to ``station_messages``, never to
-- ``contributions`` (which is what the main score is driven by). With this
-- flag ON (the default), ``agent_engine.process_agent_turn`` runs a small
-- Tier-2 analyzer check on every agent reply; if the LLM scores the reply
-- as contribution-worthy (delta magnitude above threshold OR rationale
-- indicates a committed stance), a row gets inserted into ``contributions``
-- with ``user_token = 'ai-agent'``.  The chart then moves on its own during
-- conversation, no structured form required.
--
-- The frontend toggle in the quorum page header PATCHes
-- /quorums/{id}/auto-promote-chat to flip this column.
ALTER TABLE quorums
  ADD COLUMN IF NOT EXISTS auto_promote_chat boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN quorums.auto_promote_chat IS
  'When TRUE, AI agent replies that score above the contribution-worthy '
  'threshold are auto-promoted into contributions rows. See '
  'apps/api/agent_engine.py::_maybe_auto_promote_contribution.';
