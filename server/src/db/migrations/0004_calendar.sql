CREATE TABLE IF NOT EXISTS calendar_occurrences (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  calendar_selection_id TEXT NOT NULL REFERENCES calendar_selections(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  provider_event_key TEXT NOT NULL,
  normalized_time_json TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'tentative', 'cancelled', 'unsupported')),
  visibility TEXT NOT NULL CHECK (visibility IN ('owner', 'shared_eligible', 'destination_context')),
  generation INTEGER NOT NULL,
  original_start TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(calendar_selection_id, occurrence_key)
);
CREATE INDEX IF NOT EXISTS calendar_occurrences_agenda_idx ON calendar_occurrences(calendar_selection_id, visibility, status, expires_at);
CREATE INDEX IF NOT EXISTS calendar_occurrences_source_idx ON calendar_occurrences(source_id, occurrence_key);
