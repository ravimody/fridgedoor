CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  endpoint_hash TEXT NOT NULL, encrypted_endpoint TEXT NOT NULL, encrypted_keys TEXT NOT NULL,
  label TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_idx ON push_subscriptions(endpoint_hash);
CREATE INDEX IF NOT EXISTS push_subscriptions_member_idx ON push_subscriptions(member_id, status);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, parent_type TEXT NOT NULL,
  parent_id TEXT NOT NULL, due_at TEXT NOT NULL, timezone TEXT NOT NULL, offset_minutes INTEGER,
  revision INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'canceled', 'expired')),
  created_by TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(state, due_at, revision);
CREATE INDEX IF NOT EXISTS reminders_recipient_idx ON reminders(recipient_id, state, due_at);
CREATE TABLE IF NOT EXISTS reminder_deliveries (
  id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'uncertain', 'expired')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(reminder_id, revision, subscription_id)
);
