-- Household roles live on members, so installs behind an identity proxy (no password
-- sign-in) have owners too. member_logins.role is kept in step for older tooling.
ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member'));
UPDATE members SET role = 'owner' WHERE id IN (SELECT member_id FROM member_logins WHERE role = 'owner');
-- Every household keeps an owner: where no active member is one, promote the earliest active member.
UPDATE members SET role = 'owner' WHERE id IN (
  SELECT (SELECT m.id FROM members m WHERE m.household_id = h.household_id AND m.active = 1 ORDER BY m.created_at, m.id LIMIT 1)
  FROM (SELECT DISTINCT household_id FROM members) h
  WHERE NOT EXISTS (SELECT 1 FROM members o WHERE o.household_id = h.household_id AND o.role = 'owner' AND o.active = 1)
);
UPDATE member_logins SET role = (SELECT role FROM members WHERE members.id = member_logins.member_id);

-- Share/capture credentials made by a signed-in phone end when that phone is signed out.
ALTER TABLE capture_credentials ADD COLUMN native_session_id TEXT REFERENCES native_sessions(id) ON DELETE SET NULL;
CREATE INDEX capture_credentials_native_session_idx ON capture_credentials(native_session_id);

-- The worker's heartbeat row was renamed.
DELETE FROM worker_health WHERE id = 'planner-worker';

-- Plan history no longer records titles while a plan is private; remove those already recorded
-- (on private plans, and before a shared plan was shared).
UPDATE history_entries SET safe_payload_json = json_remove(safe_payload_json, '$.title')
WHERE json_extract(safe_payload_json, '$.title') IS NOT NULL AND (
  plan_id IN (SELECT id FROM plans WHERE visibility = 'private')
  OR created_at < (SELECT MIN(s.created_at) FROM history_entries s WHERE s.plan_id = history_entries.plan_id AND s.type = 'proposal_shared')
  OR (json_extract(safe_payload_json, '$.visibility') = 'private')
);

-- Only kept for a one-off Access subject migration that has been removed.
DROP TABLE IF EXISTS access_subject_observations;

-- Voice transcription attempts, so the hourly limit survives restarts. Kept for a day.
CREATE TABLE transcription_attempts (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  attempted_at TEXT NOT NULL
);
CREATE INDEX transcription_attempts_member_idx ON transcription_attempts(member_id, attempted_at);
