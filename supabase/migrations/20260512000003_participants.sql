-- =============================================================================
-- Participants — one row per QR scan (laptop or phone)
--
-- The station page used to write `user_token = "anon-local"` on every
-- contribution, so the system had no idea WHICH human said what.  Multi-attendee
-- at one station is a feature (it's deliberation), but contributions need to
-- be attributed to the individual participant.
--
-- A `participants` row is minted on:
--   1. QR scan on a phone  → /pair page POSTs /sessions/participant (phone)
--   2. First load of the station page on a laptop → POSTs /sessions/participant (laptop)
--
-- display_name is auto-assigned: "Visitor 1", "Visitor 2", ... per
-- (quorum_id, station_label).  No JWT, no token exchange — just a UUID.
-- =============================================================================

CREATE TABLE IF NOT EXISTS participants (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quorum_id          uuid NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    role_id            uuid REFERENCES roles(id) ON DELETE SET NULL,
    station_label      text,
    display_name       text NOT NULL,
    device_kind        text NOT NULL CHECK (device_kind IN ('laptop','phone')),
    last_heartbeat_at  timestamptz DEFAULT now(),
    created_at         timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS participants_quorum_idx    ON participants(quorum_id);
CREATE INDEX IF NOT EXISTS participants_heartbeat_idx ON participants(last_heartbeat_at);

-- Attribute station_messages + contributions to the originating participant.
ALTER TABLE station_messages
    ADD COLUMN IF NOT EXISTS participant_id uuid REFERENCES participants(id) ON DELETE SET NULL;

ALTER TABLE contributions
    ADD COLUMN IF NOT EXISTS participant_id uuid REFERENCES participants(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- RLS: dashboards SELECT freely (presence dots), service-role-only writes.
-- Mirrors the pattern established for the agent system tables.
-- -----------------------------------------------------------------------------
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS participants_select_open ON participants;
DROP POLICY IF EXISTS participants_insert_service ON participants;
DROP POLICY IF EXISTS participants_update_service ON participants;
DROP POLICY IF EXISTS participants_delete_service ON participants;

CREATE POLICY participants_select_open
    ON participants FOR SELECT USING (true);
CREATE POLICY participants_insert_service
    ON participants FOR INSERT
    WITH CHECK (auth.role() = 'service_role');
CREATE POLICY participants_update_service
    ON participants FOR UPDATE
    USING (auth.role() = 'service_role');
CREATE POLICY participants_delete_service
    ON participants FOR DELETE
    USING (auth.role() = 'service_role');
