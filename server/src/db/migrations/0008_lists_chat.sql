CREATE TABLE IF NOT EXISTS list_items (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('todo', 'grocery')), title TEXT NOT NULL, quantity TEXT,
  assignee_id TEXT REFERENCES members(id) ON DELETE SET NULL, due_time_json TEXT,
  completed_at TEXT, archived_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS list_items_household_idx ON list_items(household_id, kind, archived_at, updated_at);
CREATE TABLE IF NOT EXISTS list_history (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES list_items(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES members(id) ON DELETE SET NULL, type TEXT NOT NULL, safe_payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), encrypted_text TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON chat_messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS chat_proposals (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('list_item')),
  encrypted_validated_payload TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'expired', 'rejected')),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT, result_json TEXT
);
