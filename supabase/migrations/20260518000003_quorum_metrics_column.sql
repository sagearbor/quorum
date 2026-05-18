-- Add a jsonb `metrics` column to `quorums` so the frontend Postgres
-- realtime subscription receives the up-to-date per-metric health values on
-- every UPDATE.  Previously the backend only persisted the composite
-- `heat_score` and broadcast detailed metrics over a separate WebSocket
-- channel that useQuorumLive did not listen to — so the secondary lines on
-- the Quorum Health Chart never updated past their initial seed.
ALTER TABLE quorums ADD COLUMN IF NOT EXISTS metrics jsonb;
