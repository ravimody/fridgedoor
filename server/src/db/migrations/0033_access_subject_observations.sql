CREATE TABLE access_subject_observations (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  previous_subject TEXT NOT NULL,
  verified_subject TEXT NOT NULL,
  conflicted INTEGER NOT NULL DEFAULT 0 CHECK(conflicted IN (0,1)),
  observed_at TEXT NOT NULL
);
