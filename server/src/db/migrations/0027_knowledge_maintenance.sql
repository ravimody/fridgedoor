CREATE TABLE knowledge_proposals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK(operation IN ('add','update','archive','merge')),
  target_keys_json TEXT NOT NULL,
  base_revisions_json TEXT NOT NULL,
  encrypted_proposed_value TEXT,
  encrypted_provenance_refs TEXT NOT NULL,
  reason TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','dismissed','applied','expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(owner_id, dedupe_key)
);
CREATE INDEX knowledge_proposals_pending_idx ON knowledge_proposals(owner_id, status, expires_at);

CREATE TABLE knowledge_tombstones (
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL,
  deleted_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, fact_key)
);

CREATE TABLE knowledge_maintenance_runs (
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, local_date, input_digest)
);
