-- Native iOS client sessions. Browser sessions, capture credentials and Access
-- identity stay unchanged; these rows only authorize the /native/v1 mount.
CREATE TABLE native_auth_codes (
  code_digest TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE native_sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE INDEX native_sessions_member_idx ON native_sessions(member_id);

-- Refresh tokens rotate on every use. Presenting a rotated token again revokes
-- the whole session (replay detection).
CREATE TABLE native_refresh_tokens (
  token_digest TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES native_sessions(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  rotated_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX native_refresh_tokens_session_idx ON native_refresh_tokens(session_id);

CREATE TABLE native_access_tokens (
  token_digest TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES native_sessions(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX native_access_tokens_session_idx ON native_access_tokens(session_id);
