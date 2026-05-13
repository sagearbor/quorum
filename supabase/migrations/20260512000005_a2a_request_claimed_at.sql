-- =============================================================================
-- A2A request CAS-claim support (Phase 10.2)
-- =============================================================================
-- Adds `claimed_at` so the autonomy loop can atomically claim a pending request
-- via a conditional UPDATE (status='pending' → 'processing'). Without this, two
-- concurrent loop ticks at high autonomy can dispatch the SAME row to the LLM
-- twice, producing duplicate insights / messages / broadcasts.
--
-- The `a2a_status` enum already includes 'processing' (added in
-- 20260314000002_agent_system.sql, before this fix shipped), so no enum ALTER
-- is required here. We add the value defensively with IF NOT EXISTS so that
-- environments which somehow predate the enum still apply cleanly.
-- =============================================================================

-- Defensive: ensure 'processing' is present in the enum (no-op on current DBs).
-- ALTER TYPE ... ADD VALUE must run outside a transaction in Postgres < 12; on
-- modern Supabase (PG14+) it is transactional and the IF NOT EXISTS clause is
-- supported. Wrapped in a DO block to swallow the "already exists" error on
-- older PGs that lack IF NOT EXISTS support.
DO $$
BEGIN
    BEGIN
        ALTER TYPE a2a_status ADD VALUE IF NOT EXISTS 'processing';
    EXCEPTION WHEN duplicate_object THEN
        -- already present; ignore
        NULL;
    END;
END$$;

-- claimed_at: set by the autonomy loop when it transitions a row to
-- 'processing'. NULL means the row has not been claimed (either still pending
-- or already past 'processing'). Used by the stale-claim reaper to detect
-- abandoned in-flight requests.
ALTER TABLE agent_requests
    ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- Index supports the reaper query: find rows in 'processing' with old
-- claimed_at. Partial index keeps it tiny since most rows are pending/resolved.
CREATE INDEX IF NOT EXISTS idx_agent_requests_processing_claimed_at
    ON agent_requests(claimed_at)
    WHERE status = 'processing';
