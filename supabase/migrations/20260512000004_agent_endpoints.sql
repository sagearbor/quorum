-- agent_endpoints — A2A endpoint registry for role-bound agents.
--
-- Replaces the process-local _agent_registry dict that lived in
-- apps/api/quorum_a2a/a2a_client.py, which lost state on every restart and
-- could not be queried from any process other than the FastAPI worker that
-- handled the role-creation request.
--
-- One row per role.  The url is the base path the A2A client POSTs tasks to —
-- the v1.0 SendMessage endpoint is appended on the client side.

CREATE TABLE IF NOT EXISTS agent_endpoints (
    role_id        uuid        PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
    -- Base URL of the agent's A2A endpoint (no trailing slash).
    -- e.g. https://api.quorum.example/a2a/agents/<uuid>
    url            text        NOT NULL,
    -- Free-form capability metadata mirrored from the AgentCard (skills,
    -- domain_tags, etc.).  Used for fast routing without re-fetching the card.
    capabilities   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    registered_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_endpoints_last_seen
    ON agent_endpoints(last_seen_at DESC);

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
-- Mirrors the 10.8 pattern: SELECT is public (anon clients need to discover
-- which agents are alive), but INSERT/UPDATE is locked to the service role
-- (the FastAPI backend has the service key; clients should never write here).

ALTER TABLE agent_endpoints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_endpoints_select_public" ON agent_endpoints;

CREATE POLICY "agent_endpoints_select_public"
    ON agent_endpoints FOR SELECT
    USING (true);

-- Service role bypasses RLS by default in Supabase, so no INSERT/UPDATE
-- policies are needed.  Anon/authenticated callers will be denied writes.

-- Realtime publication (optional — useful for live dashboards that show
-- which agents are online).  Wrapped in DO/EXCEPTION so re-runs and local
-- environments without the supabase_realtime publication don't error.
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE agent_endpoints;
EXCEPTION
    WHEN duplicate_object THEN NULL;     -- table already in publication
    WHEN undefined_object THEN NULL;     -- publication doesn't exist (local dev)
END $$;
