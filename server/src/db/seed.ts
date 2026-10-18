import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../config.js';
import { migrate } from './migrate.js';
const config = loadConfig();
if (!process.env.FRIDGEDOOR_MEMBER_SUBJECT || !process.env.FRIDGEDOOR_MEMBER_EMAIL) throw new Error('FRIDGEDOOR_MEMBER_SUBJECT and FRIDGEDOOR_MEMBER_EMAIL are required');
mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
const db = new Database(config.DATABASE_PATH); migrate(db); const now = new Date().toISOString();
db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(process.env.FRIDGEDOOR_HOUSEHOLD_ID ?? 'household-1', now);
// Bootstrap only: deployment must never reactivate or rebind an existing member.
// A household's first member is its owner.
const hasOwner = db.prepare("SELECT 1 FROM members WHERE household_id = ? AND role = 'owner' AND active = 1").get(process.env.FRIDGEDOOR_HOUSEHOLD_ID ?? 'household-1');
db.prepare('INSERT INTO members (id, household_id, access_subject, allowed_email, display_name, timezone, active, role, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING').run(process.env.FRIDGEDOOR_MEMBER_ID ?? 'member-1', process.env.FRIDGEDOOR_HOUSEHOLD_ID ?? 'household-1', process.env.FRIDGEDOOR_MEMBER_SUBJECT, process.env.FRIDGEDOOR_MEMBER_EMAIL.toLowerCase(), process.env.FRIDGEDOOR_MEMBER_NAME ?? 'Fridgedoor member', process.env.FRIDGEDOOR_MEMBER_TIMEZONE ?? 'America/New_York', hasOwner ? 'member' : 'owner', now);
db.close();
