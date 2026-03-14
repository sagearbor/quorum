-- =============================================================================
-- Agent System: Phase 1
-- Adds tables for per-station conversation history, collaborative documents,
-- cross-station insights, A2A requests, oscillation tracking, and agent configs.
-- =============================================================================

-- pgvector is required for embedding columns. Supabase includes this extension.
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE message_role AS ENUM ('user', 'assistant', 'system');

CREATE TYPE insight_type AS ENUM (
    'summary',
    'conflict',
    'suggestion',
    'question',
    'decision',
    'escalation'
);

CREATE TYPE a2a_status AS ENUM (
    'pending',
    'acknowledged',
    'processing',
    'resolved',
    'expired'
);

CREATE TYPE a2a_request_type AS ENUM (
    'conflict_flag',
    'input_request',
    'review_request',
    'doc_edit_notify',
    'escalation',
    'negotiation'
);

CREATE TYPE doc_status AS ENUM ('active', 'superseded', 'canceled');

CREATE TYPE doc_format AS ENUM ('json', 'yaml', 'csv', 'markdown');

-- =============================================================================
-- AGENT CONFIGURATION (per role, set at quorum creation)
-- Stores LLM tuning parameters and domain tags for each agent-role instance.
-- slug references a definition file in agents/definitions/ (not a FK — file-based).
-- =============================================================================

CREATE TABLE agent_configs (
    id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id                 uuid        NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    quorum_id               uuid        NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    -- slug matches filename in agents/definitions/ (e.g., "irb_officer")
    agent_slug              text,
    system_prompt           text        NOT NULL,
    temperature             double precision NOT NULL DEFAULT 0.4,
    max_tokens              integer     NOT NULL DEFAULT 1024,
    -- Document types this agent is permitted to create or edit
    doc_permissions         text[]      NOT NULL DEFAULT ARRAY[]::text[],
    -- If true the agent may create new documents without human approval
    auto_create_docs        boolean     NOT NULL DEFAULT false,
    -- If true the agent may propose dashboard configuration changes
    auto_suggest_dashboards boolean     NOT NULL DEFAULT false,
    -- Domain tags seeded by the architect and refined at runtime
    domain_tags             text[]      NOT NULL DEFAULT ARRAY[]::text[],
    created_at              timestamptz NOT NULL DEFAULT now(),
    -- One config per role — enforced here; role uniqueness is sufficient
    -- since a role belongs to exactly one quorum.
    UNIQUE(role_id)
);

CREATE INDEX idx_agent_configs_quorum     ON agent_configs(quorum_id);
CREATE INDEX idx_agent_configs_slug       ON agent_configs(agent_slug);
CREATE INDEX idx_agent_configs_tags       ON agent_configs USING GIN(domain_tags);

-- =============================================================================
-- STATION MESSAGES (per-station conversation history)
-- Stores every human and agent message at a station, with extracted tags and
-- an optional embedding for semantic retrieval.
-- =============================================================================

CREATE TABLE station_messages (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    quorum_id   uuid        NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    role_id     uuid        NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    -- station_id is the ?station=N URL param value, stored as text
    station_id  text        NOT NULL,
    role        message_role NOT NULL,
    content     text        NOT NULL,
    -- Tags extracted from this message for affinity matching
    tags        text[]      NOT NULL DEFAULT ARRAY[]::text[],
    -- 1536-dim embedding for ada-002; nullable — populated asynchronously
    embedding   vector(1536),
    metadata    jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_station_messages_quorum_role ON station_messages(quorum_id, role_id);
CREATE INDEX idx_station_messages_station     ON station_messages(station_id);
CREATE INDEX idx_station_messages_created_at  ON station_messages(created_at);
CREATE INDEX idx_station_messages_tags        ON station_messages USING GIN(tags);
-- IVFFLAT index for fast approximate nearest-neighbor on the embedding column.
-- lists=20 is appropriate for up to ~100K rows; tune upward for larger datasets.
CREATE INDEX idx_station_messages_embedding   ON station_messages
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);

-- =============================================================================
-- AGENT DOCUMENTS (collaboratively edited structured docs)
-- All edits use optimistic locking (CAS on version) identical to artifacts.
-- =============================================================================

CREATE TABLE agent_documents (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    quorum_id           uuid        NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    title               text        NOT NULL,
    -- Free-form type label used by dashboards to select a renderer
    -- (e.g., 'budget', 'timeline', 'protocol', 'risk_register')
    doc_type            text        NOT NULL,
    format              doc_format  NOT NULL DEFAULT 'json',
    -- Full document content stored as JSONB; see PRP section 4 for envelope schema
    content             jsonb       NOT NULL,
    status              doc_status  NOT NULL DEFAULT 'active',
    -- Monotonically increasing; bumped on every successful CAS write
    version             integer     NOT NULL DEFAULT 1,
    -- Tags describing the document's domain (used for agent affinity routing)
    tags                text[]      NOT NULL DEFAULT ARRAY[]::text[],
    created_by_role_id  uuid        REFERENCES roles(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_documents_quorum  ON agent_documents(quorum_id);
CREATE INDEX idx_agent_documents_status  ON agent_documents(status);
CREATE INDEX idx_agent_documents_tags    ON agent_documents USING GIN(tags);
CREATE INDEX idx_agent_documents_type    ON agent_documents(doc_type);

-- =============================================================================
-- DOCUMENT CHANGES (append-only audit trail — never update or delete rows)
-- Each row is a snapshot of a single edit: who changed what, why, and what the
-- document looked like before.  Used for oscillation detection and rollback.
-- =============================================================================

CREATE TABLE document_changes (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id      uuid        NOT NULL REFERENCES agent_documents(id) ON DELETE CASCADE,
    -- version of the document AFTER this change (matches agent_documents.version)
    version          integer     NOT NULL,
    changed_by_role  uuid        NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    -- 'create' | 'edit' | 'status_change'
    change_type      text        NOT NULL,
    -- JSON patch or field-level diff produced by the editing agent
    diff             jsonb       NOT NULL,
    -- Agent's stated reason for making this change
    rationale        text,
    -- Full document snapshot before this change (enables point-in-time rollback)
    previous_content jsonb,
    -- Tags derived from the change diff, for affinity-based wake-up routing
    tags             text[]      NOT NULL DEFAULT ARRAY[]::text[],
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_changes_doc     ON document_changes(document_id);
CREATE INDEX idx_document_changes_role    ON document_changes(changed_by_role);
CREATE INDEX idx_document_changes_created ON document_changes(created_at);
-- Oscillation detector queries recent changes by (document_id, version DESC)
CREATE INDEX idx_document_changes_doc_ver ON document_changes(document_id, version DESC);

-- =============================================================================
-- AGENT INSIGHTS (cross-station shared bulletin board)
-- Agents publish tagged observations here; other agents read insights whose tags
-- overlap with their own domain_tags (Jaccard similarity gate).
-- =============================================================================

CREATE TABLE agent_insights (
    id              uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
    quorum_id       uuid            NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    source_role_id  uuid            NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    insight_type    insight_type    NOT NULL DEFAULT 'summary',
    content         text            NOT NULL,
    -- Metadata tags used for affinity routing to other agents
    tags            text[]          NOT NULL DEFAULT ARRAY[]::text[],
    -- Optional reference to the document this insight is about
    document_id     uuid            REFERENCES agent_documents(id),
    -- Self-assessed relevance score (0.0–1.0) set by the producing agent
    self_relevance  double precision NOT NULL DEFAULT 0.5,
    -- 1536-dim embedding for semantic retrieval; nullable — populated async
    embedding       vector(1536),
    version         integer         NOT NULL DEFAULT 1,
    created_at      timestamptz     NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_insights_quorum    ON agent_insights(quorum_id);
CREATE INDEX idx_agent_insights_source    ON agent_insights(source_role_id);
CREATE INDEX idx_agent_insights_tags      ON agent_insights USING GIN(tags);
CREATE INDEX idx_agent_insights_type      ON agent_insights(insight_type);
CREATE INDEX idx_agent_insights_embedding ON agent_insights
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);

-- =============================================================================
-- A2A REQUESTS (agent-to-agent direct communication)
-- An A2A request is the primary wake-up trigger for dormant agents.
-- CAS on version prevents double-processing concurrent acknowledgements.
-- =============================================================================

CREATE TABLE agent_requests (
    id             uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
    quorum_id      uuid             NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    from_role_id   uuid             NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    to_role_id     uuid             NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    request_type   a2a_request_type NOT NULL,
    content        text             NOT NULL,
    -- Tags from the originating message used for context filtering
    tags           text[]           NOT NULL DEFAULT ARRAY[]::text[],
    -- Optional reference to the document under discussion
    document_id    uuid             REFERENCES agent_documents(id),
    status         a2a_status       NOT NULL DEFAULT 'pending',
    response       text,
    -- Tags extracted from the target agent's response
    response_tags  text[]           NOT NULL DEFAULT ARRAY[]::text[],
    -- CAS field: bump on every status transition to prevent concurrent writes
    version        integer          NOT NULL DEFAULT 1,
    -- 0 = lowest; 4 = critical (escalation). Higher values are processed first.
    priority       integer          NOT NULL DEFAULT 0,
    created_at     timestamptz      NOT NULL DEFAULT now(),
    resolved_at    timestamptz
);

CREATE INDEX idx_agent_requests_quorum   ON agent_requests(quorum_id);
-- Primary query pattern: "what pending requests are waiting for role X?"
CREATE INDEX idx_agent_requests_to_role  ON agent_requests(to_role_id, status);
CREATE INDEX idx_agent_requests_from_role ON agent_requests(from_role_id);
CREATE INDEX idx_agent_requests_tags     ON agent_requests USING GIN(tags);
CREATE INDEX idx_agent_requests_document ON agent_requests(document_id);

-- =============================================================================
-- OSCILLATION EVENTS (document field flip-flopping detection)
-- Written by the oscillation detector when it observes >= 2 A→B→A cycles on
-- the same field path.  Triggers automatic escalation to a higher-rank role.
-- =============================================================================

CREATE TABLE oscillation_events (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     uuid        NOT NULL REFERENCES agent_documents(id) ON DELETE CASCADE,
    quorum_id       uuid        NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    -- JSON path of the oscillating field (e.g. "sections.budget.line_items[2].amount")
    field_path      text        NOT NULL,
    -- Number of complete A→B→A cycles detected
    cycle_count     integer     NOT NULL,
    -- IDs of the roles that were involved in the oscillation
    involved_roles  uuid[]      NOT NULL,
    -- The actual values that flipped, in sequence, as a JSONB array
    values_sequence jsonb       NOT NULL,
    -- True once an escalation A2A request has been created for this event
    escalated       boolean     NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_oscillation_document ON oscillation_events(document_id);
CREATE INDEX idx_oscillation_quorum   ON oscillation_events(quorum_id);

-- =============================================================================
-- ENABLE REALTIME
-- Subscribes all new tables to the Supabase realtime publication so the
-- frontend can receive live pushes on each channel.
-- =============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE station_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_documents;
ALTER PUBLICATION supabase_realtime ADD TABLE document_changes;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_insights;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_requests;
ALTER PUBLICATION supabase_realtime ADD TABLE oscillation_events;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_configs;

-- =============================================================================
-- ROW LEVEL SECURITY
-- Open policies matching the existing tables (20260225000001_initial_schema.sql).
-- Restrict to authenticated users in production by replacing these with proper
-- policies once the auth model is defined.
-- =============================================================================

ALTER TABLE agent_configs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_messages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_documents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_changes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_insights      ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_requests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE oscillation_events  ENABLE ROW LEVEL SECURITY;

-- Allow all operations for now (mirrors existing schema approach)
CREATE POLICY "allow_all_agent_configs"      ON agent_configs      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_station_messages"   ON station_messages   FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_agent_documents"    ON agent_documents    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_document_changes"   ON document_changes   FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_agent_insights"     ON agent_insights     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_agent_requests"     ON agent_requests     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_oscillation_events" ON oscillation_events FOR ALL USING (true) WITH CHECK (true);
