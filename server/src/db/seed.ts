import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../config.js';
import { migrate } from './migrate.js';
const config = loadConfig();
if (!process.env.PLANNER_MEMBER_SUBJECT || !process.env.PLANNER_MEMBER_EMAIL) throw new Error('PLANNER_MEMBER_SUBJECT and PLANNER_MEMBER_EMAIL are required');
mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
const db = new Database(config.DATABASE_PATH); migrate(db); const now = new Date().toISOString();
db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(process.env.PLANNER_HOUSEHOLD_ID ?? 'household-1', now);
// Bootstrap only: deployment must never reactivate or rebind an existing member.
db.prepare('INSERT INTO members (id, household_id, access_subject, allowed_email, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(id) DO NOTHING').run(process.env.PLANNER_MEMBER_ID ?? 'member-1', process.env.PLANNER_HOUSEHOLD_ID ?? 'household-1', process.env.PLANNER_MEMBER_SUBJECT, process.env.PLANNER_MEMBER_EMAIL.toLowerCase(), process.env.PLANNER_MEMBER_NAME ?? 'Planner user', process.env.PLANNER_MEMBER_TIMEZONE ?? 'America/New_York', now);
db.close();
