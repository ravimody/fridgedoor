CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'running', 'retry_wait', 'succeeded', 'failed', 'canceled')),
  run_after TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(state, run_after, created_at);
CREATE INDEX IF NOT EXISTS jobs_scope_idx ON jobs(scope_id, state);

CREATE TABLE IF NOT EXISTS sync_states (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES google_connections(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  stream_key TEXT NOT NULL,
  cursor TEXT,
  initial_anchor TEXT,
  page_token TEXT,
  query_version TEXT NOT NULL,
  last_success_at TEXT,
  error_code TEXT,
  generation INTEGER NOT NULL,
  stream_lease_token TEXT,
  stream_lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id, source_kind, stream_key)
);
CREATE INDEX IF NOT EXISTS sync_states_connection_idx ON sync_states(connection_id, source_kind);

CREATE TABLE IF NOT EXISTS source_items (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES google_connections(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('gmail_message', 'calendar_event', 'capture')),
  provider_key TEXT NOT NULL,
  encrypted_provider_refs TEXT NOT NULL,
  current_version_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('available', 'expired', 'deleted', 'disconnected', 'unsupported')),
  generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, kind, provider_key)
);
CREATE INDEX IF NOT EXISTS source_items_owner_idx ON source_items(owner_id, kind, state);
CREATE INDEX IF NOT EXISTS source_items_connection_idx ON source_items(connection_id, generation);

CREATE TABLE IF NOT EXISTS source_versions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  encrypted_evidence TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  original_at TEXT,
  expires_at TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('available', 'expired', 'deleted', 'incomplete')),
  metadata_json TEXT NOT NULL,
  UNIQUE(source_id, sequence),
  UNIQUE(source_id, content_digest)
);
CREATE INDEX IF NOT EXISTS source_versions_expiry_idx ON source_versions(expires_at, availability);
