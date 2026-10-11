ALTER TABLE members ADD COLUMN allowed_email TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS google_connections (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
  google_sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL, grants_json TEXT NOT NULL,
  encrypted_tokens TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','paused','needs_reauth','disconnected')),
  generation INTEGER NOT NULL DEFAULT 1, disclosure_version TEXT NOT NULL, consented_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_attempts (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE, state_hash TEXT NOT NULL UNIQUE,
  nonce_hash TEXT NOT NULL, encrypted_pkce_verifier TEXT NOT NULL, disclosure_version TEXT NOT NULL,
  expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_policies (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  excluded_senders_json TEXT NOT NULL DEFAULT '[]', excluded_labels_json TEXT NOT NULL DEFAULT '[]',
  generic_appointment_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (generic_appointment_opt_in IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deletion_ledger (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  source_key TEXT, deleted_at TEXT NOT NULL, generation INTEGER NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calendar_selections (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES google_connections(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL, encrypted_calendar_id TEXT NOT NULL, calendar_key TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1)), classification TEXT NOT NULL CHECK (classification IN ('household','personal','work')),
  provider_access_role TEXT NOT NULL, display_name TEXT NOT NULL, UNIQUE(connection_id, calendar_key)
);
CREATE TABLE IF NOT EXISTS destination_bindings (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  encrypted_calendar_id TEXT NOT NULL, calendar_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), created_at TEXT NOT NULL
);
