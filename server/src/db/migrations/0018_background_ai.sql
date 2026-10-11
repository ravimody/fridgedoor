CREATE TABLE background_ai_settings (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  consent_version TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE background_ai_attempts (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX background_ai_attempts_member_time ON background_ai_attempts(member_id, attempted_at);
CREATE INDEX background_ai_attempts_source ON background_ai_attempts(source_version_id, model);
