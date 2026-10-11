CREATE TABLE relevance_trial_items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
  encrypted_snapshot TEXT NOT NULL,
  encrypted_rating TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(owner_id, plan_id)
);
CREATE INDEX relevance_trial_owner ON relevance_trial_items(owner_id, position);
