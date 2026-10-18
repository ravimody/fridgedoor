CREATE TABLE IF NOT EXISTS capture_credentials (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  label TEXT NOT NULL, token_digest TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS capture_credentials_member_idx ON capture_credentials(member_id, status);
