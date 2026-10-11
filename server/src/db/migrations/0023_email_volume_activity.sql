CREATE TABLE activity_events_expanded (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('request','plan','action','email_volume')),
  source_id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES activity_groups(id) ON DELETE CASCADE,
  PRIMARY KEY(member_id,event_key)
);
INSERT INTO activity_events_expanded SELECT * FROM activity_events;
DROP TABLE activity_events;
ALTER TABLE activity_events_expanded RENAME TO activity_events;
