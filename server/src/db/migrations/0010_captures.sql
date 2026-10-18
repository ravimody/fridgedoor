CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE, client_capture_id TEXT NOT NULL,
  body_digest TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('text', 'url', 'file')),
  mime_type TEXT, byte_count INTEGER NOT NULL DEFAULT 0, encrypted_blob TEXT, text_value TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'ready', 'rejected', 'expired')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id, client_capture_id)
);
CREATE INDEX IF NOT EXISTS captures_owner_idx ON captures(owner_id, created_at);
