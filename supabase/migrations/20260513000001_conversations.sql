-- =============================================================================
-- Conversations — persistent Pydantic AI MessageHistory per (quorum, role, participant)
--
-- Checklist item 9.2.
--
-- Before this migration, every agent turn (process_agent_turn /
-- process_a2a_request) started with NO memory of prior turns: the engine
-- assembled context from station_messages / insights / docs each time, but the
-- Pydantic AI Agent itself was stateless.  Pydantic AI 1.94 exposes a
-- ``message_history`` parameter on ``Agent.run`` that lets us thread the full
-- typed message sequence (with tool calls, structured outputs, etc.) between
-- runs — which is strictly richer than the dict-shaped chat-history we already
-- pass.
--
-- The ``messages`` JSONB column holds the serialised Pydantic AI message list
-- produced by ``ModelMessagesTypeAdapter.dump_python(..., mode='json')`` — a
-- list of ``ModelRequest`` / ``ModelResponse`` records.  We deserialise on read
-- via ``ModelMessagesTypeAdapter.validate_python(...)`` and pass the result
-- straight to ``Agent.run(message_history=...)``.
--
-- Uniqueness: one row per (quorum_id, role_id, participant_id) triple.
-- ``participant_id`` is nullable so autonomous agent-to-agent turns (no
-- participant attached) all share a single bucket per role.  The PG unique
-- constraint treats NULLs as distinct by default — see partial unique indexes
-- below for the NULL-aware variant.
-- =============================================================================

CREATE TABLE IF NOT EXISTS conversations (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    quorum_id       uuid        NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    role_id         uuid        NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    -- NULL = autonomous agent-to-agent conversation (no human participant)
    participant_id  uuid        REFERENCES participants(id) ON DELETE SET NULL,
    -- Pydantic AI serialised message history (list of ModelMessage records).
    -- Default empty array so ``load_history`` always returns a list-shaped
    -- value even on a brand-new row.
    messages        jsonb       NOT NULL DEFAULT '[]'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup by the (quorum, role) pair — every agent turn loads its history
-- via this index.  Participant is part of the unique key but most reads scope
-- to (quorum, role).
CREATE INDEX IF NOT EXISTS idx_conversations_quorum_role
    ON conversations(quorum_id, role_id);

-- Uniqueness on (quorum_id, role_id, participant_id).  Postgres treats NULLs
-- as distinct in a plain UNIQUE constraint, which would let two NULL-participant
-- rows accumulate for the same (quorum, role) — exactly the duplicate we want
-- to prevent for autonomous agent-to-agent buckets.  Split into two partial
-- unique indexes that handle NULL and non-NULL cases explicitly.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_unique_with_participant
    ON conversations(quorum_id, role_id, participant_id)
    WHERE participant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_unique_null_participant
    ON conversations(quorum_id, role_id)
    WHERE participant_id IS NULL;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- Mirrors the lockdown pattern in 20260512000002_agent_rls_lockdown.sql:
--   SELECT  -> open (dashboards / live transcripts read freely)
--   INSERT/UPDATE/DELETE -> service_role only (FastAPI backend holds the key)
-- DROP POLICY IF EXISTS prefix on each CREATE POLICY so re-runs are idempotent
-- (audit lesson from PR #14).
-- -----------------------------------------------------------------------------
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversations_select_open    ON conversations;
DROP POLICY IF EXISTS conversations_insert_service ON conversations;
DROP POLICY IF EXISTS conversations_update_service ON conversations;
DROP POLICY IF EXISTS conversations_delete_service ON conversations;

CREATE POLICY conversations_select_open
    ON conversations FOR SELECT USING (true);

CREATE POLICY conversations_insert_service
    ON conversations FOR INSERT
    WITH CHECK (auth.role() = 'service_role');

CREATE POLICY conversations_update_service
    ON conversations FOR UPDATE
    USING (auth.role() = 'service_role');

CREATE POLICY conversations_delete_service
    ON conversations FOR DELETE
    USING (auth.role() = 'service_role');

-- -----------------------------------------------------------------------------
-- Realtime publication
-- Wrapped in DO/EXCEPTION so the migration re-applies cleanly on environments
-- that either already have the table in the publication or don't have the
-- supabase_realtime publication at all (local dev with bare Postgres).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
EXCEPTION
    WHEN duplicate_object THEN NULL;     -- table already in publication
    WHEN undefined_object THEN NULL;     -- publication doesn't exist (local dev)
END $$;
