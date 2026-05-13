-- =============================================================================
-- Agent Tables RLS Lockdown
--
-- Migration 20260314000002_agent_system.sql created seven agent-system tables
-- with `FOR ALL USING (true) WITH CHECK (true)` policies — anyone with the
-- Supabase URL (which is exposed in the browser bundle as
-- NEXT_PUBLIC_SUPABASE_URL) could write arbitrary rows from devtools.
--
-- This migration drops the wide-open policies and replaces them with:
--   SELECT  -> open (dashboards, /display route, station UIs read these tables)
--   INSERT/UPDATE/DELETE -> auth.role() = 'service_role' (FastAPI backend only)
--
-- The FastAPI backend authenticates with SUPABASE_SERVICE_KEY (see
-- apps/api/database.py), so its writes continue to work.  Direct writes from
-- the frontend (currently none — audited via grep on apps/web/src/) would
-- start returning RLS violations; the migration to FastAPI-mediated writes
-- is tracked separately.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- agent_configs
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "allow_all_agent_configs" ON agent_configs;

CREATE POLICY agent_configs_select_open
    ON agent_configs FOR SELECT USING (true);
CREATE POLICY agent_configs_insert_service
    ON agent_configs FOR INSERT
    WITH CHECK (auth.role() = 'service_role');
CREATE POLICY agent_configs_update_service
    ON agent_configs FOR UPDATE
    USING (auth.role() = 'service_role');
CREATE POLICY agent_configs_delete_service
    ON agent_configs FOR DELETE
    USING (auth.role() = 'service_role');

-- -----------------------------------------------------------------------------
-- station_messages
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "allow_all_station_messages" ON station_messages;

CREATE POLICY station_messages_select_open
    ON station_messages FOR SELECT USING (true);
CREATE POLICY station_messages_insert_service
    ON station_messages FOR INSERT
    WITH CHECK (auth.role() = 'service_role');
CREATE POLICY station_messages_update_service
    ON station_messages FOR UPDATE
    USING (auth.role() = 'service_role');
CREATE POLICY station_messages_delete_service
    ON station_messages FOR DELETE
    USING (auth.role() = 'service_role');

-- -----------------------------------------------------------------------------
-- agent_documents
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "allow_all_agent_documents" ON agent_documents;

CREATE POLICY agent_documents_select_open
    ON agent_documents FOR SELECT USING (true);
CREATE POLICY agent_documents_insert_service
    ON agent_documents FOR INSERT
    WITH CHECK (auth.role() = 'service_role');
CREATE POLICY agent_documents_update_service
    ON agent_documents FOR UPDATE
    USING (auth.role() = 'service_role');
CREATE POLICY agent_documents_delete_service
    ON agent_documents FOR DELETE
    USING (auth.role() = 'service_role');

-- -----------------------------------------------------------------------------
-- document_changes
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "allow_all_document_changes" ON document_changes;

CREATE POLICY document_changes_select_open
    ON document_changes FOR SELECT USING (true);
CREATE POLICY document_changes_insert_service
    ON document_changes FOR INSERT
    WITH CHECK (auth.role() = 'service_role');
CREATE POLICY document_changes_update_service
    ON document_changes FOR UPDATE
    USING (auth.role() = 'service_role');
CREATE POLICY document_changes_delete_service
    ON document_changes FOR DELETE
    USING (auth.role() = 'service_role');

-- -----------------------------------------------------------------------------
-- agent_insights
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "allow_all_agent_insights" ON agent_insights;

CREATE POLICY agent_insights_select_open
    ON agent_insights FOR SELECT USING (true);
CREATE POLICY agent_insights_insert_service
    ON agent_insights FOR INSERT
    WITH CHECK (auth.role() = 'service_role');
CREATE POLICY agent_insights_update_service
    ON agent_insights FOR UPDATE
    USING (auth.role() = 'service_role');
CREATE POLICY agent_insights_delete_service
    ON agent_insights FOR DELETE
    USING (auth.role() = 'service_role');

-- -----------------------------------------------------------------------------
-- agent_requests
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "allow_all_agent_requests" ON agent_requests;

CREATE POLICY agent_requests_select_open
    ON agent_requests FOR SELECT USING (true);
CREATE POLICY agent_requests_insert_service
    ON agent_requests FOR INSERT
    WITH CHECK (auth.role() = 'service_role');
CREATE POLICY agent_requests_update_service
    ON agent_requests FOR UPDATE
    USING (auth.role() = 'service_role');
CREATE POLICY agent_requests_delete_service
    ON agent_requests FOR DELETE
    USING (auth.role() = 'service_role');

-- -----------------------------------------------------------------------------
-- oscillation_events
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "allow_all_oscillation_events" ON oscillation_events;

CREATE POLICY oscillation_events_select_open
    ON oscillation_events FOR SELECT USING (true);
CREATE POLICY oscillation_events_insert_service
    ON oscillation_events FOR INSERT
    WITH CHECK (auth.role() = 'service_role');
CREATE POLICY oscillation_events_update_service
    ON oscillation_events FOR UPDATE
    USING (auth.role() = 'service_role');
CREATE POLICY oscillation_events_delete_service
    ON oscillation_events FOR DELETE
    USING (auth.role() = 'service_role');
