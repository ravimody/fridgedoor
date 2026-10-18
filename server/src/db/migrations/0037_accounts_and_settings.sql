-- Built-in accounts replace an external identity proxy. A member signs in with an
-- email and password; `members.access_subject` becomes `local:<member id>`.
CREATE TABLE member_logins (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One-time links that let someone join a household.
CREATE TABLE household_invites (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES members(id) ON DELETE SET NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX household_invites_household_idx ON household_invites(household_id);

-- One-time pairing codes shown as a QR code so a phone can sign in without typing.
CREATE TABLE device_pairing_codes (
  code_digest TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

-- Display details for a household (kept apart so existing inserts stay valid).
CREATE TABLE household_profiles (
  household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Server settings edited in the web app (AI provider, public address, push keys...).
-- Values are encrypted JSON envelopes; environment variables take precedence.
CREATE TABLE app_settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
