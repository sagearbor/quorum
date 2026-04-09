-- Add autonomy_level column to quorums table.
-- Controls how proactively agents communicate via A2A (0.0-1.0).
ALTER TABLE quorums ADD COLUMN autonomy_level double precision NOT NULL DEFAULT 0.0;
