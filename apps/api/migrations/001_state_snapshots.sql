-- State snapshots: compressed quorum state written after each synthesis run.
CREATE TABLE IF NOT EXISTS quorum_state_snapshots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quorum_id   UUID NOT NULL REFERENCES quorums(id) ON DELETE CASCADE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_state_snapshots_quorum
    ON quorum_state_snapshots(quorum_id, updated_at DESC);
