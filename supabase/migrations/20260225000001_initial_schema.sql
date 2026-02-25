-- Quorum: Initial Schema
-- All tables from CONTRACT.md with enums, constraints, foreign keys, and indexes.

-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE quorum_status AS ENUM ('open', 'active', 'resolved', 'archived');
CREATE TYPE artifact_status AS ENUM ('draft', 'pending_ratification', 'final');
CREATE TYPE carousel_mode AS ENUM ('multi-view', 'multi-quorum');

-- =============================================================================
-- TABLES
-- =============================================================================

-- Events: top-level container for a Quorum session
CREATE TABLE events (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text NOT NULL,
    slug           text NOT NULL UNIQUE,
    access_code    text NOT NULL,
    max_active_quorums integer NOT NULL DEFAULT 5,
    created_by     text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- Quorums: a single problem-solving session within an event
CREATE TABLE quorums (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    title          text NOT NULL,
    description    text,
    status         quorum_status NOT NULL DEFAULT 'open',
    heat_score     double precision NOT NULL DEFAULT 0,
    dashboard_types text[] NOT NULL DEFAULT ARRAY['quorum_health_chart'],
    carousel_mode  carousel_mode NOT NULL DEFAULT 'multi-view',
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- Roles: authority-ranked positions within a quorum
CREATE TABLE roles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quorum_id       uuid NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    name            text NOT NULL,
    capacity        text NOT NULL DEFAULT 'unlimited',
    authority_rank  integer NOT NULL DEFAULT 0,
    prompt_template jsonb,
    fallback_chain  uuid[],
    color           text
);

-- Contributions: individual inputs from participants
CREATE TABLE contributions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quorum_id         uuid NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    role_id           uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    user_token        text NOT NULL,
    content           text NOT NULL,
    structured_fields jsonb,
    tier_processed    integer,
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- Artifacts: generated output documents from quorum resolution
CREATE TABLE artifacts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quorum_id     uuid NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    version       integer NOT NULL DEFAULT 1,
    content_hash  text,
    sections      jsonb,
    status        artifact_status NOT NULL DEFAULT 'draft',
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Artifact versions: historical snapshots for diff/audit
CREATE TABLE artifact_versions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id  uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    version      integer NOT NULL,
    sections     jsonb,
    diff         jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- INDEXES
-- =============================================================================

-- Events: slug lookups are the primary access pattern
-- (UNIQUE constraint already creates an index on slug)

-- Quorums: filter by event and status
CREATE INDEX idx_quorums_event_id ON quorums(event_id);
CREATE INDEX idx_quorums_status ON quorums(status);

-- Roles: lookup by quorum
CREATE INDEX idx_roles_quorum_id ON roles(quorum_id);

-- Contributions: lookup by quorum, role, and time ordering
CREATE INDEX idx_contributions_quorum_id ON contributions(quorum_id);
CREATE INDEX idx_contributions_role_id ON contributions(role_id);
CREATE INDEX idx_contributions_created_at ON contributions(created_at);

-- Artifacts: lookup by quorum
CREATE INDEX idx_artifacts_quorum_id ON artifacts(quorum_id);

-- Artifact versions: lookup by artifact
CREATE INDEX idx_artifact_versions_artifact_id ON artifact_versions(artifact_id);
