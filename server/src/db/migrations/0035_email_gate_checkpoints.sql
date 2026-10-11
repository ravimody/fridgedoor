CREATE TABLE email_gate_checkpoints (
  source_version_id TEXT PRIMARY KEY REFERENCES source_versions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  encrypted_checkpoint TEXT NOT NULL
);

-- Source retention keeps tombstone rows; purge checkpoints when content is removed.
CREATE TRIGGER purge_email_gate_checkpoint
AFTER UPDATE OF availability, encrypted_evidence ON source_versions
WHEN NEW.availability <> 'available' OR NEW.encrypted_evidence = ''
BEGIN
  DELETE FROM email_gate_checkpoints WHERE source_version_id = NEW.id;
END;
