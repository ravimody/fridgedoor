CREATE TABLE activity_config (id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL);
INSERT INTO activity_config VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE activity_presence (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY(member_id, client_id)
);
CREATE TABLE activity_groups (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('review','failure','update')),
  ready_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE activity_events (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('request','plan','action')),
  source_id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES activity_groups(id) ON DELETE CASCADE,
  PRIMARY KEY(member_id,event_key)
);
CREATE TABLE activity_deliveries (
  group_id TEXT NOT NULL REFERENCES activity_groups(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','uncertain','expired','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(group_id,subscription_id)
);
CREATE INDEX activity_ready_idx ON activity_groups(ready_at,expires_at);
