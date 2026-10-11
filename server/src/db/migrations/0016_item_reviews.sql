CREATE TABLE assistant_item_reviews (
  run_id TEXT NOT NULL REFERENCES assistant_runs(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('saved', 'kept', 'calendar', 'dismissed', 'draft')),
  plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
  PRIMARY KEY (run_id, target)
);
ALTER TABLE plans ADD COLUMN kept_at TEXT;
