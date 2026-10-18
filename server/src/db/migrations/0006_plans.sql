CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL CHECK (visibility IN ('shared', 'private')),
  owner_id TEXT REFERENCES members(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('needs_details', 'proposed', 'dismissed', 'accepted', 'archived')),
  current_version_id TEXT,
  pending_version_id TEXT,
  dismissal_fingerprint TEXT,
  possible_duplicate_plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((visibility = 'shared' AND owner_id IS NULL) OR (visibility = 'private' AND owner_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS plans_household_idx ON plans(household_id, visibility, status, updated_at);
CREATE INDEX IF NOT EXISTS plans_owner_idx ON plans(owner_id, status, updated_at);
CREATE TABLE IF NOT EXISTS plan_versions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('shared', 'private')),
  owner_id TEXT REFERENCES members(id) ON DELETE CASCADE,
  fact_json TEXT,
  encrypted_fact_json TEXT,
  material_fingerprint TEXT NOT NULL,
  previous_version_id TEXT REFERENCES plan_versions(id) ON DELETE SET NULL,
  origin TEXT NOT NULL CHECK (origin IN ('extraction', 'user')),
  actor_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('new', 'update', 'cancel')),
  created_at TEXT NOT NULL,
  UNIQUE(plan_id, sequence),
  CHECK ((visibility = 'shared' AND owner_id IS NULL AND fact_json IS NOT NULL AND encrypted_fact_json IS NULL) OR (visibility = 'private' AND owner_id IS NOT NULL AND encrypted_fact_json IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS plan_versions_fingerprint_idx ON plan_versions(material_fingerprint, visibility);
CREATE TABLE IF NOT EXISTS plan_sources (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  evidence_role TEXT NOT NULL,
  PRIMARY KEY(plan_id, source_version_id)
);
CREATE INDEX IF NOT EXISTS plan_sources_owner_idx ON plan_sources(owner_id, source_version_id);
CREATE TABLE IF NOT EXISTS history_entries (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  safe_payload_json TEXT NOT NULL,
  private_source_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_plan_idx ON history_entries(plan_id, created_at);
