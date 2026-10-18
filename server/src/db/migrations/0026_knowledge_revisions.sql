ALTER TABLE assistant_knowledge ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assistant_knowledge ADD COLUMN provenance TEXT NOT NULL DEFAULT 'legacy' CHECK(provenance IN ('legacy','user','source','maintenance'));
ALTER TABLE assistant_knowledge ADD COLUMN confirmation TEXT NOT NULL DEFAULT 'unconfirmed' CHECK(confirmation IN ('confirmed','unconfirmed'));
ALTER TABLE assistant_knowledge ADD COLUMN valid_from TEXT;
ALTER TABLE assistant_knowledge ADD COLUMN valid_until TEXT;
ALTER TABLE assistant_knowledge ADD COLUMN archived_at TEXT;
ALTER TABLE assistant_knowledge ADD COLUMN relation_key TEXT;
ALTER TABLE assistant_knowledge ADD COLUMN encrypted_source_manifest TEXT;

CREATE TABLE knowledge_changes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  result_revision INTEGER NOT NULL,
  encrypted_before TEXT,
  encrypted_after TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('user','review','maintenance')),
  reason TEXT NOT NULL,
  encrypted_source_manifest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  undo_until TEXT NOT NULL
);
CREATE INDEX knowledge_changes_owner_idx ON knowledge_changes(owner_id, fact_key, created_at);
