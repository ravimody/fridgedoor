CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('succeeded', 'failed', 'incomplete', 'expired')),
  encrypted_result TEXT,
  usage_json TEXT NOT NULL,
  error_code TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_version_id, provider, model, prompt_version, policy_version)
);
CREATE INDEX IF NOT EXISTS extractions_owner_expiry_idx ON extractions(expires_at, state);
