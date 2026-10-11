import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {migrate} from '../db/migrate.js';
import {keyFromSecret} from '../crypto.js';
import {auditMorning} from './morning-audit.js';
it('does not claim a future run happened and reports a missing enabled AI review without writing',()=>{
  const db=new Database(':memory:');migrate(db);const now=new Date('2026-09-20T10:55:00Z');
  db.prepare("INSERT INTO households (id, created_at) VALUES ('h',?)").run(now.toISOString());
  db.prepare("INSERT INTO members (id,household_id,access_subject,display_name,timezone,active,created_at) VALUES ('a','h','s','Owner','America/New_York',1,?)").run(now.toISOString());
  db.prepare("INSERT INTO daily_ai_settings VALUES ('a',1,'daily-assistant-v1',1,?)").run(now.toISOString());db.prepare("INSERT INTO digest_settings VALUES ('a',1,'07:00',1,?)").run(now.toISOString());
  db.pragma('query_only=ON');
  expect(auditMorning(db,keyFromSecret('audit'),now)).toEqual([{date:'2026-09-20',status:'not_due'}]);
  expect(auditMorning(db,keyFromSecret('audit'),new Date('2026-09-20T11:10:00Z'))[0]).toMatchObject({status:'needs_attention',review:'unavailable'});db.close();
});
