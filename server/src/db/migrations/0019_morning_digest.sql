CREATE TABLE digest_settings (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  local_time TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE digest_days (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  settings_revision INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(member_id, local_date)
);
CREATE TABLE digest_deliveries (
  member_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','uncertain','expired')),
  attempts INTEGER NOT NULL DEFAULT 1,
  next_attempt_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(member_id, local_date, subscription_id),
  FOREIGN KEY(member_id, local_date) REFERENCES digest_days(member_id, local_date) ON DELETE CASCADE
);
