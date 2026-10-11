CREATE TABLE morning_dismissals (
 owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 candidate_ref TEXT NOT NULL,
 dismissed_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,candidate_ref)
);
