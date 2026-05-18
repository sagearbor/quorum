-- Bump statement_timeout for the service_role so cascade-deletes on events
-- (which can fan out to hundreds of rows across quorums, contributions,
-- agent_documents, etc.) don't trip PostgREST's default 8 s limit.
-- 60 s gives plenty of headroom while still catching runaway queries.
ALTER ROLE service_role SET statement_timeout = '60s';

-- Reload PostgREST's role cache so the change takes effect immediately
-- instead of after the next connection cycle.
NOTIFY pgrst, 'reload config';
