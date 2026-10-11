-- Private subscription links (webcal://) that let any calendar app show a member's
-- saved and added plans. The token in the URL is the credential; only its digest is kept.
CREATE TABLE calendar_feeds (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_fetched_at TEXT,
  revoked_at TEXT
);
CREATE INDEX calendar_feeds_member_idx ON calendar_feeds(member_id);
