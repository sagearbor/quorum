-- =============================================================================
-- Synthesis Snapshots
-- Tracks each tier of LLM synthesis output (keyword extraction, conflict
-- detection, final artifact synthesis) for a quorum.  Written from the
-- backend SupabaseBackend.store_synthesis() path; previously missing here
-- and only mocked in apps/api/db/sqlite_schema.sql, which crashed live
-- Supabase with `relation "synthesis_snapshots" does not exist`.
-- =============================================================================

CREATE TABLE IF NOT EXISTS synthesis_snapshots (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    quorum_id        uuid        NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    -- Which synthesis tier produced this snapshot
    tier             text        NOT NULL CHECK (tier IN ('keyword','conflict','synthesis')),
    -- Full structured output of the tier (raw JSON envelope)
    content          jsonb       NOT NULL,
    -- Contribution IDs the snapshot was derived from
    contribution_ids uuid[]      NOT NULL DEFAULT ARRAY[]::uuid[],
    -- Estimated token cost (sum of prompt + completion tokens, nullable for tier 1)
    token_cost       integer,
    -- Model identifier used for tiers 2/3 (e.g. "gpt-4o-mini", "gpt-4o")
    model            text,
    -- Monotonically increasing per (quorum_id, tier); bumped on re-synthesis
    version          integer     NOT NULL DEFAULT 1,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX synthesis_snapshots_quorum_idx
    ON synthesis_snapshots (quorum_id, created_at DESC);

-- =============================================================================
-- ROW LEVEL SECURITY
-- Mirrors the lockdown pattern in 20260512000002_agent_rls_lockdown.sql:
--   SELECT  -> open (dashboards display synthesis history)
--   INSERT/UPDATE/DELETE -> service_role only (FastAPI backend writes)
-- =============================================================================

ALTER TABLE synthesis_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY synthesis_snapshots_select_open
    ON synthesis_snapshots FOR SELECT USING (true);

CREATE POLICY synthesis_snapshots_insert_service
    ON synthesis_snapshots FOR INSERT
    WITH CHECK (auth.role() = 'service_role');

CREATE POLICY synthesis_snapshots_update_service
    ON synthesis_snapshots FOR UPDATE
    USING (auth.role() = 'service_role');

CREATE POLICY synthesis_snapshots_delete_service
    ON synthesis_snapshots FOR DELETE
    USING (auth.role() = 'service_role');
