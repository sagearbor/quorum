-- =============================================================================
-- 10.10 — Publish participants to supabase_realtime so presence dots can subscribe
--
-- The 20260512000003_participants.sql migration created the table and
-- /sessions/heartbeat keeps last_heartbeat_at fresh (every 30s).  However the
-- table was never added to the supabase_realtime publication, so the frontend
-- never receives INSERT/UPDATE/DELETE postgres_changes events for it.
--
-- Wrapped in DO ... EXCEPTION so re-applying the migration on environments
-- where it already exists is a no-op (matches the audit pattern used in
-- 20260512000004_agent_endpoints.sql).
-- =============================================================================

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE participants;
EXCEPTION
    WHEN duplicate_object THEN
        -- Already in the publication — nothing to do.
        NULL;
    WHEN undefined_object THEN
        -- supabase_realtime publication doesn't exist in this environment (eg
        -- a stripped-down test DB).  Skip — presence will fall back to the
        -- 15s client-side re-evaluation tick.
        NULL;
END $$;
