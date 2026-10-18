CREATE TABLE clarifications (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  encrypted_question TEXT NOT NULL,
  encrypted_reason TEXT NOT NULL,
  encrypted_source_manifest TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  target_key TEXT NOT NULL,
  expected_target_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','answered','dismissed','expired')),
  encrypted_answer TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(owner_id, dedupe_key)
);
CREATE INDEX clarifications_owner_state_idx ON clarifications(owner_id, state, expires_at);
