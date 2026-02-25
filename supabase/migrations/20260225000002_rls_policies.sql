-- Quorum: Row Level Security Policies
-- Read: public (anon) for open quorums
-- Write: authenticated users only

-- =============================================================================
-- ENABLE RLS ON ALL TABLES
-- =============================================================================

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE quorums ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_versions ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- EVENTS
-- =============================================================================

-- Anyone can read events (needed to look up by slug)
CREATE POLICY "events_select_public"
    ON events FOR SELECT
    USING (true);

-- Only authenticated users can create events
CREATE POLICY "events_insert_authenticated"
    ON events FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- Only the event creator can update their event
CREATE POLICY "events_update_owner"
    ON events FOR UPDATE
    TO authenticated
    USING (created_by = auth.uid()::text);

-- =============================================================================
-- QUORUMS
-- =============================================================================

-- Anyone can read quorums (needed for station URLs and display route)
CREATE POLICY "quorums_select_public"
    ON quorums FOR SELECT
    USING (true);

-- Authenticated users can create quorums (architects)
CREATE POLICY "quorums_insert_authenticated"
    ON quorums FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- Authenticated users can update quorums (status changes, heat score)
CREATE POLICY "quorums_update_authenticated"
    ON quorums FOR UPDATE
    TO authenticated
    USING (true);

-- =============================================================================
-- ROLES
-- =============================================================================

-- Anyone can read roles (needed to show role pills on station)
CREATE POLICY "roles_select_public"
    ON roles FOR SELECT
    USING (true);

-- Authenticated users can create/update roles
CREATE POLICY "roles_insert_authenticated"
    ON roles FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "roles_update_authenticated"
    ON roles FOR UPDATE
    TO authenticated
    USING (true);

-- =============================================================================
-- CONTRIBUTIONS
-- =============================================================================

-- Anyone can read contributions (needed for dashboards and display)
CREATE POLICY "contributions_select_public"
    ON contributions FOR SELECT
    USING (true);

-- Authenticated users can submit contributions
CREATE POLICY "contributions_insert_authenticated"
    ON contributions FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- =============================================================================
-- ARTIFACTS
-- =============================================================================

-- Anyone can read artifacts (needed for display and download)
CREATE POLICY "artifacts_select_public"
    ON artifacts FOR SELECT
    USING (true);

-- Authenticated users can create/update artifacts (LLM synthesis writes)
CREATE POLICY "artifacts_insert_authenticated"
    ON artifacts FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "artifacts_update_authenticated"
    ON artifacts FOR UPDATE
    TO authenticated
    USING (true);

-- =============================================================================
-- ARTIFACT VERSIONS
-- =============================================================================

-- Anyone can read artifact versions (diff view is public)
CREATE POLICY "artifact_versions_select_public"
    ON artifact_versions FOR SELECT
    USING (true);

-- Authenticated users can create versions (system writes on artifact update)
CREATE POLICY "artifact_versions_insert_authenticated"
    ON artifact_versions FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- =============================================================================
-- SERVICE ROLE BYPASS
-- Note: The service_role key bypasses RLS by default in Supabase.
-- The FastAPI backend uses the service key for all writes, so these
-- authenticated policies primarily govern direct client-side access.
-- =============================================================================
