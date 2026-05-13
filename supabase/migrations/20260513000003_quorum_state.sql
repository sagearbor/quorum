-- =============================================================================
-- quorum_state — the orchestrator's shared blackboard, one row per quorum
--
-- Checklist item 11.6 (stretch).  Unlocks 11.7 (authority arbitration).
--
-- Today the Magentic-One orchestrator (PR #14) picks the next speaker from a
-- snapshot of recent contributions.  It has NO shared surface to track what
-- proposals are on the table, which decisions have been made, what conflicts
-- exist, or which roles have formally dissented.  That makes authority
-- arbitration impossible: there's no "current proposal" object for a higher-
-- authority role to override, and no "open decision" object to dissent
-- against.  The blackboard fixes that by giving agents (and the projector)
-- a single canvas with five jsonb lists.
--
-- Sub-shapes (documented inline in CONTRACT.md as well):
--   open_questions : [{id, text, raised_by_role_id, raised_at, tags[]}]
--   proposals      : [{id, field, content, proposed_by_role_id, proposed_at,
--                       supporters: role_id[], blockers: role_id[]}]
--   decisions      : [{id, field, content, decided_by_role_id, decided_at,
--                       authority_rank, source_proposal_id}]
--   conflicts      : [{id, field, proposals: proposal_id[], raised_at}]
--   dissents       : [{id, decision_id, dissenting_role_id, reason,
--                       dissented_at}]
--
-- All mutations use CAS on ``version``: read the row, mutate the jsonb in
-- application code, write back with ``.eq("version", v)`` and bump version
-- to ``v + 1``.  On version mismatch (rowcount == 0) callers retry with a
-- fresh read.  This is identical to the artifact-versioning pattern already
-- in production (see resolve_quorum in routes.py).
-- =============================================================================

CREATE TABLE IF NOT EXISTS quorum_state (
    quorum_id       uuid        PRIMARY KEY REFERENCES quorums(id) ON DELETE CASCADE,
    open_questions  jsonb       NOT NULL DEFAULT '[]'::jsonb,
    proposals       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    decisions       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    conflicts       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    dissents        jsonb       NOT NULL DEFAULT '[]'::jsonb,
    version         int         NOT NULL DEFAULT 1,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Row Level Security
-- Mirrors the lockdown pattern in 20260512000002_agent_rls_lockdown.sql:
--   SELECT  -> open (projector / dashboards read freely)
--   INSERT/UPDATE/DELETE -> service_role only (FastAPI backend holds the key)
-- DROP POLICY IF EXISTS prefix on each CREATE POLICY so re-runs are idempotent
-- (audit lesson from PR #14).
-- -----------------------------------------------------------------------------
ALTER TABLE quorum_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quorum_state_select_open    ON quorum_state;
DROP POLICY IF EXISTS quorum_state_insert_service ON quorum_state;
DROP POLICY IF EXISTS quorum_state_update_service ON quorum_state;
DROP POLICY IF EXISTS quorum_state_delete_service ON quorum_state;

CREATE POLICY quorum_state_select_open
    ON quorum_state FOR SELECT USING (true);

CREATE POLICY quorum_state_insert_service
    ON quorum_state FOR INSERT
    WITH CHECK (auth.role() = 'service_role');

CREATE POLICY quorum_state_update_service
    ON quorum_state FOR UPDATE
    USING (auth.role() = 'service_role');

CREATE POLICY quorum_state_delete_service
    ON quorum_state FOR DELETE
    USING (auth.role() = 'service_role');

-- -----------------------------------------------------------------------------
-- Realtime publication
-- Wrapped in DO/EXCEPTION so the migration re-applies cleanly on environments
-- that either already have the table in the publication or don't have the
-- supabase_realtime publication at all (local dev with bare Postgres).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE quorum_state;
EXCEPTION
    WHEN duplicate_object THEN NULL;     -- table already in publication
    WHEN undefined_object THEN NULL;     -- publication doesn't exist (local dev)
END $$;
