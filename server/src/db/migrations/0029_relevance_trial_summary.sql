CREATE TABLE relevance_trial_summaries (
  owner_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  input_digest TEXT NOT NULL,
  encrypted_summary TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
