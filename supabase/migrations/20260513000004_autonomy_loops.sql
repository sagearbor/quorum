-- =============================================================================
-- autonomy_loop_state — durable bookkeeping for the per-quorum autonomy loop
-- Checklist item 11.5.
--
-- Before this migration the autonomy loop tracked which quorums were ticking
-- in a module-level dict (``apps/api/autonomy_loop.py:_active_loops``). That
-- dict survives neither a uvicorn restart nor a second worker:
--
--   • Restart: the dict is empty, so every quorum with autonomy_level > 0
--     silently stops ticking. No reaper, no resume.
--   • Multi-worker: each uvicorn worker has its OWN dict. A POST that hits
--     worker B has no idea worker A is already running the same loop, so
--     two workers happily double-dispatch every round.
--
-- The new table is the source of truth. The in-process dict in
-- ``autonomy_loop.py`` is kept ONLY as a handle map so each worker can
-- ``.cancel()`` its own asyncio.Task — it is never read for "is this loop
-- running?" — that question is now answered by ``status='running'`` AND
-- ``heartbeat_at > now() - interval '60s'`` on this row.
--
-- Worker leases:
--   worker_id is set to ``${HOSTNAME}:${PID}`` (or hostname + pid when
--   $HOSTNAME is unset). Each loop iteration UPDATEs heartbeat_at; if a
--   worker dies the row goes stale and (when AUTONOMY_LOOP_RECLAIM_ORPHANS
--   is true) another worker reclaims it on startup.
-- =============================================================================

CREATE TABLE IF NOT EXISTS autonomy_loop_state (
    quorum_id       uuid        PRIMARY KEY REFERENCES quorums(id) ON DELETE CASCADE,
    autonomy_level  numeric     NOT NULL,
    status          text        NOT NULL CHECK (status IN ('running', 'stopped', 'orphaned')),
    worker_id       text,                                   -- ${HOSTNAME}:${PID} of the owning worker, or NULL when stopped
    heartbeat_at    timestamptz NOT NULL DEFAULT now(),     -- bumped every loop iteration; >60s stale = orphaned
    next_tick_at    timestamptz,                            -- best-effort hint, useful for dashboards
    round_num       int         NOT NULL DEFAULT 0,
    started_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Reaper lookup: find stale 'running' rows fast.
CREATE INDEX IF NOT EXISTS idx_autonomy_loop_state_running_heartbeat
    ON autonomy_loop_state(heartbeat_at)
    WHERE status = 'running';

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
-- SELECT is open so live dashboards can show "which quorums are autonomous?"
-- All writes are service-role only — this table tracks worker leases and
-- must never be mutated by anon/authenticated clients.

ALTER TABLE autonomy_loop_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "autonomy_loop_state_select_open"          ON autonomy_loop_state;
DROP POLICY IF EXISTS "autonomy_loop_state_insert_service_role"  ON autonomy_loop_state;
DROP POLICY IF EXISTS "autonomy_loop_state_update_service_role"  ON autonomy_loop_state;
DROP POLICY IF EXISTS "autonomy_loop_state_delete_service_role"  ON autonomy_loop_state;

CREATE POLICY "autonomy_loop_state_select_open"
    ON autonomy_loop_state FOR SELECT
    USING (true);

CREATE POLICY "autonomy_loop_state_insert_service_role"
    ON autonomy_loop_state FOR INSERT
    WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "autonomy_loop_state_update_service_role"
    ON autonomy_loop_state FOR UPDATE
    USING (auth.role() = 'service_role');

CREATE POLICY "autonomy_loop_state_delete_service_role"
    ON autonomy_loop_state FOR DELETE
    USING (auth.role() = 'service_role');

-- Realtime publication — optional. Useful so the architect dashboard can
-- light up when a worker reclaims an orphaned loop without a refresh.
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE autonomy_loop_state;
EXCEPTION
    WHEN duplicate_object THEN NULL;     -- already in publication
    WHEN undefined_object THEN NULL;     -- publication doesn't exist (local dev)
END $$;
