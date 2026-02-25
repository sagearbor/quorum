-- Quorum: Enable Supabase Realtime
-- Publish changes for quorums, contributions, and artifacts tables.
-- Dashboard clients subscribe to these for live updates.

ALTER PUBLICATION supabase_realtime ADD TABLE quorums;
ALTER PUBLICATION supabase_realtime ADD TABLE contributions;
ALTER PUBLICATION supabase_realtime ADD TABLE artifacts;
