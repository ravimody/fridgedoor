ALTER TABLE assistant_item_reviews ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1));
ALTER TABLE assistant_item_reviews ADD COLUMN list_item_id TEXT REFERENCES list_items(id) ON DELETE SET NULL;
ALTER TABLE assistant_item_reviews ADD COLUMN list_revision INTEGER;
ALTER TABLE assistant_item_reviews ADD COLUMN undone_at TEXT;
