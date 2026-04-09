-- Quorum: SQLite-compatible schema
-- Mirrors the Supabase Postgres schema with SQLite-compatible types.
-- JSON columns stored as TEXT, UUIDs as TEXT, timestamps as TEXT (ISO 8601).

-- =============================================================================
-- CORE TABLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS events (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    access_code     TEXT NOT NULL,
    max_active_quorums INTEGER NOT NULL DEFAULT 5,
    created_by      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS quorums (
    id              TEXT PRIMARY KEY,
    event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'open',
    heat_score      REAL NOT NULL DEFAULT 0,
    dashboard_types TEXT NOT NULL DEFAULT '["quorum_health_chart"]',
    carousel_mode   TEXT NOT NULL DEFAULT 'multi-view',
    autonomy_level  REAL NOT NULL DEFAULT 0.0,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_quorums_event_id ON quorums(event_id);
CREATE INDEX IF NOT EXISTS idx_quorums_status   ON quorums(status);

CREATE TABLE IF NOT EXISTS roles (
    id              TEXT PRIMARY KEY,
    quorum_id       TEXT NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    capacity        TEXT NOT NULL DEFAULT 'unlimited',
    authority_rank  INTEGER NOT NULL DEFAULT 0,
    prompt_template TEXT,
    fallback_chain  TEXT,
    blocked_by      TEXT DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'active',
    color           TEXT
);

CREATE INDEX IF NOT EXISTS idx_roles_quorum_id     ON roles(quorum_id);
CREATE INDEX IF NOT EXISTS idx_roles_quorum_status ON roles(quorum_id, status);

CREATE TABLE IF NOT EXISTS contributions (
    id                TEXT PRIMARY KEY,
    quorum_id         TEXT NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    role_id           TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    user_token        TEXT NOT NULL,
    content           TEXT NOT NULL,
    structured_fields TEXT,
    tier_processed    INTEGER,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_contributions_quorum_id  ON contributions(quorum_id);
CREATE INDEX IF NOT EXISTS idx_contributions_role_id    ON contributions(role_id);
CREATE INDEX IF NOT EXISTS idx_contributions_created_at ON contributions(created_at);

CREATE TABLE IF NOT EXISTS artifacts (
    id            TEXT PRIMARY KEY,
    quorum_id     TEXT NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL DEFAULT 1,
    content_hash  TEXT,
    sections      TEXT,
    status        TEXT NOT NULL DEFAULT 'draft',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_quorum_id ON artifacts(quorum_id);

CREATE TABLE IF NOT EXISTS artifact_versions (
    id           TEXT PRIMARY KEY,
    artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    sections     TEXT,
    diff         TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact_id ON artifact_versions(artifact_id);

-- =============================================================================
-- AGENT SYSTEM TABLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_configs (
    id                      TEXT PRIMARY KEY,
    role_id                 TEXT NOT NULL UNIQUE REFERENCES roles(id) ON DELETE CASCADE,
    quorum_id               TEXT NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    agent_slug              TEXT,
    system_prompt           TEXT NOT NULL,
    temperature             REAL NOT NULL DEFAULT 0.4,
    max_tokens              INTEGER NOT NULL DEFAULT 1024,
    doc_permissions         TEXT NOT NULL DEFAULT '[]',
    auto_create_docs        INTEGER NOT NULL DEFAULT 0,
    auto_suggest_dashboards INTEGER NOT NULL DEFAULT 0,
    domain_tags             TEXT NOT NULL DEFAULT '[]',
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_configs_quorum ON agent_configs(quorum_id);
CREATE INDEX IF NOT EXISTS idx_agent_configs_slug   ON agent_configs(agent_slug);

CREATE TABLE IF NOT EXISTS station_messages (
    id          TEXT PRIMARY KEY,
    quorum_id   TEXT NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    station_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    metadata    TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_station_messages_quorum_role ON station_messages(quorum_id, role_id);
CREATE INDEX IF NOT EXISTS idx_station_messages_station     ON station_messages(station_id);
CREATE INDEX IF NOT EXISTS idx_station_messages_created_at  ON station_messages(created_at);

CREATE TABLE IF NOT EXISTS agent_documents (
    id                  TEXT PRIMARY KEY,
    quorum_id           TEXT NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    title               TEXT NOT NULL,
    doc_type            TEXT NOT NULL,
    format              TEXT NOT NULL DEFAULT 'json',
    content             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active',
    version             INTEGER NOT NULL DEFAULT 1,
    tags                TEXT NOT NULL DEFAULT '[]',
    created_by_role_id  TEXT REFERENCES roles(id),
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_documents_quorum ON agent_documents(quorum_id);
CREATE INDEX IF NOT EXISTS idx_agent_documents_status ON agent_documents(status);
CREATE INDEX IF NOT EXISTS idx_agent_documents_type   ON agent_documents(doc_type);

CREATE TABLE IF NOT EXISTS document_changes (
    id               TEXT PRIMARY KEY,
    document_id      TEXT NOT NULL REFERENCES agent_documents(id) ON DELETE CASCADE,
    version          INTEGER NOT NULL,
    changed_by_role  TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    change_type      TEXT NOT NULL,
    diff             TEXT NOT NULL,
    rationale        TEXT,
    previous_content TEXT,
    tags             TEXT NOT NULL DEFAULT '[]',
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_document_changes_doc     ON document_changes(document_id);
CREATE INDEX IF NOT EXISTS idx_document_changes_role    ON document_changes(changed_by_role);
CREATE INDEX IF NOT EXISTS idx_document_changes_created ON document_changes(created_at);
CREATE INDEX IF NOT EXISTS idx_document_changes_doc_ver ON document_changes(document_id, version DESC);

CREATE TABLE IF NOT EXISTS agent_insights (
    id              TEXT PRIMARY KEY,
    quorum_id       TEXT NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    source_role_id  TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    insight_type    TEXT NOT NULL DEFAULT 'summary',
    content         TEXT NOT NULL,
    tags            TEXT NOT NULL DEFAULT '[]',
    document_id     TEXT REFERENCES agent_documents(id),
    self_relevance  REAL NOT NULL DEFAULT 0.5,
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_insights_quorum ON agent_insights(quorum_id);
CREATE INDEX IF NOT EXISTS idx_agent_insights_source ON agent_insights(source_role_id);
CREATE INDEX IF NOT EXISTS idx_agent_insights_type   ON agent_insights(insight_type);

CREATE TABLE IF NOT EXISTS agent_requests (
    id             TEXT PRIMARY KEY,
    quorum_id      TEXT NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    from_role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    to_role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    request_type   TEXT NOT NULL,
    content        TEXT NOT NULL,
    tags           TEXT NOT NULL DEFAULT '[]',
    document_id    TEXT REFERENCES agent_documents(id),
    status         TEXT NOT NULL DEFAULT 'pending',
    response       TEXT,
    response_tags  TEXT NOT NULL DEFAULT '[]',
    version        INTEGER NOT NULL DEFAULT 1,
    priority       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    resolved_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_requests_quorum    ON agent_requests(quorum_id);
CREATE INDEX IF NOT EXISTS idx_agent_requests_to_role   ON agent_requests(to_role_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_requests_from_role ON agent_requests(from_role_id);
CREATE INDEX IF NOT EXISTS idx_agent_requests_document  ON agent_requests(document_id);

CREATE TABLE IF NOT EXISTS oscillation_events (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL REFERENCES agent_documents(id) ON DELETE CASCADE,
    quorum_id       TEXT NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    field_path      TEXT NOT NULL,
    cycle_count     INTEGER NOT NULL,
    involved_roles  TEXT NOT NULL,
    values_sequence TEXT NOT NULL,
    escalated       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_oscillation_document ON oscillation_events(document_id);
CREATE INDEX IF NOT EXISTS idx_oscillation_quorum   ON oscillation_events(quorum_id);

-- =============================================================================
-- STATE SNAPSHOTS
-- =============================================================================

CREATE TABLE IF NOT EXISTS quorum_state_snapshots (
    id          TEXT PRIMARY KEY,
    quorum_id   TEXT NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    snapshot    TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_state_snapshots_quorum
    ON quorum_state_snapshots(quorum_id, updated_at DESC);

-- =============================================================================
-- SYNTHESIS SNAPSHOTS
-- =============================================================================

CREATE TABLE IF NOT EXISTS synthesis_snapshots (
    id          TEXT PRIMARY KEY,
    quorum_id   TEXT NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
