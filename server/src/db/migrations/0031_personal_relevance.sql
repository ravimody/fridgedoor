CREATE TABLE personal_relevance (
  owner_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  encrypted_state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE relevance_learning_days (
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  PRIMARY KEY(owner_id, local_date)
);
