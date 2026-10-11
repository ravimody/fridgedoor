CREATE TABLE assistant_settings (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  consent_version TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE assistant_runs (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL, capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,
  encrypted_input TEXT NOT NULL, encrypted_result TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed')),
  applied_at TEXT, plan_ids_json TEXT, error_code TEXT, feedback TEXT,
  metrics_json TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  UNIQUE(owner_id, client_id)
);
CREATE INDEX assistant_runs_owner ON assistant_runs(owner_id, created_at);
CREATE TABLE assistant_knowledge (
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL, encrypted_value TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, fact_key)
);
