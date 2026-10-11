CREATE TABLE daily_ai_settings (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  consent_version TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE daily_overviews (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  consent_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','ready','failed')),
  revision INTEGER NOT NULL DEFAULT 1,
  encrypted_result TEXT,
  encrypted_source_manifest TEXT,
  generated_at TEXT,
  expires_at TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, local_date, timezone)
);
CREATE INDEX daily_overviews_owner_expiry_idx ON daily_overviews(owner_id, expires_at, state);

CREATE TABLE ai_usage_attempts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  feature TEXT NOT NULL CHECK(feature IN ('daily_overview','daily_maintenance')),
  logical_request TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  model TEXT NOT NULL,
  service_tier TEXT,
  prompt_version TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER,
  input_tokens INTEGER,
  cached_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  provider_request_id TEXT,
  UNIQUE(owner_id, feature, logical_request, attempt)
);
CREATE INDEX ai_usage_attempts_owner_day_idx ON ai_usage_attempts(owner_id, feature, local_date, timezone);
