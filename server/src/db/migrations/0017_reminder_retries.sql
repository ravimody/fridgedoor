ALTER TABLE reminder_deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reminder_deliveries ADD COLUMN next_attempt_at TEXT;
