ALTER TABLE sync_states ADD COLUMN calendar_full_sync_at TEXT;
ALTER TABLE sync_states ADD COLUMN calendar_refresh_token TEXT;
ALTER TABLE sync_states ADD COLUMN calendar_refresh_started_at TEXT;
ALTER TABLE calendar_occurrences ADD COLUMN refresh_token TEXT;
