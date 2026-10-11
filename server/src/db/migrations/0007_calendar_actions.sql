CREATE TABLE IF NOT EXISTS calendar_actions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  writer_connection_id TEXT NOT NULL REFERENCES google_connections(id) ON DELETE RESTRICT,
  writer_generation INTEGER NOT NULL,
  binding_id TEXT NOT NULL REFERENCES destination_bindings(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('create', 'update', 'cancel')),
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  expected_etag TEXT,
  provider_event_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'reconciling', 'succeeded', 'conflict', 'needs_reauth', 'failed', 'canceled')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plan_id, plan_version_id, kind, binding_id)
);
CREATE INDEX IF NOT EXISTS calendar_actions_household_idx ON calendar_actions(household_id, created_at);
CREATE TABLE IF NOT EXISTS event_bindings (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL REFERENCES destination_bindings(id) ON DELETE RESTRICT,
  encrypted_event_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  writer_connection_id TEXT NOT NULL REFERENCES google_connections(id) ON DELETE RESTRICT,
  last_etag TEXT,
  last_applied_fact_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'cancelled', 'conflict')),
  UNIQUE(plan_id, binding_id)
);
CREATE TABLE IF NOT EXISTS idempotency_records (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL,
  action_id TEXT REFERENCES calendar_actions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(member_id, route, idempotency_key)
);
