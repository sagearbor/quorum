-- Add archived_at column to events for soft-archive support.
-- NULL = active; non-NULL = archived (hidden from the architect list by default
-- but still queryable via include_archived=true).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_events_archived_at ON events(archived_at);
