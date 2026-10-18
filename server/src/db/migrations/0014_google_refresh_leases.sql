CREATE TABLE google_refresh_leases (
  connection_id TEXT PRIMARY KEY REFERENCES google_connections(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
