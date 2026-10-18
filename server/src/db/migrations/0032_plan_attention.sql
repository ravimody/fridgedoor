CREATE TABLE plan_attention (
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  consent_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('coordination','decision','disruption')),
  encrypted_reason TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,plan_id)
);
