-- Add blocked_by dependency chains to roles
ALTER TABLE roles ADD COLUMN IF NOT EXISTS blocked_by uuid[] DEFAULT '{}';
ALTER TABLE roles ADD COLUMN IF NOT EXISTS status text DEFAULT 'active' CHECK (status IN ('pending','blocked','active','completed'));
CREATE INDEX IF NOT EXISTS idx_roles_quorum_status ON roles(quorum_id, status);
