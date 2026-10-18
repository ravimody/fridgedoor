import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { SourceRepository } from '../repos/sources.js';
import { JobQueue } from './queue.js';
import { Scheduler } from './scheduler.js';

describe('scheduler', () => {
  it('creates one five-minute source job per active connection and daily retention work', () => {
    const db = new Database(':memory:'); migrate(db); const now = new Date('2026-01-01T00:02:00.000Z');
    db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString()); db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Alex', 'America/New_York', 1, now.toISOString());
    db.prepare('INSERT INTO google_connections (id, member_id, google_sub, email, grants_json, encrypted_tokens, status, generation, disclosure_version, consented_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('c1', 'm1', 'g1', 'alex@example.test', '[]', '{}', 'active', 2, 'v1', now.toISOString(), now.toISOString(), now.toISOString());
    const queue = new JobQueue(db, () => now); const scheduler = new Scheduler(db, queue, new SourceRepository(db, keyFromSecret('secret'), () => now), () => now); scheduler.tick(); scheduler.tick();
    expect(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind = 'gmail_sync'").get()).toEqual({ count: 1 }); expect(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind = 'retention'").get()).toEqual({ count: 1 }); expect(db.prepare('SELECT generation FROM sync_states').get()).toEqual({ generation: 2 });
  });
  it('prefetches an enabled owner overview only inside the local morning window', () => {
    const db = new Database(':memory:'); migrate(db); const now = new Date('2026-01-01T12:02:00.000Z');
    db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString());
    db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Owner', 'America/New_York', 1, now.toISOString());
    db.prepare('INSERT INTO digest_settings VALUES (?, 1, ?, 1, ?)').run('m1', '07:00', now.toISOString());
    db.prepare('INSERT INTO daily_ai_settings VALUES (?, 1, ?, 4, ?)').run('m1', 'daily-assistant-v1', now.toISOString());
    const queue = new JobQueue(db, () => now); const scheduler = new Scheduler(db, queue, new SourceRepository(db, keyFromSecret('secret'), () => now), () => now);
    scheduler.tick(); scheduler.tick();
    expect(db.prepare("SELECT kind, scope_id, dedupe_key, payload_json FROM jobs WHERE kind = 'daily_overview'").all()).toHaveLength(1);
    expect(db.prepare("SELECT payload_json FROM jobs WHERE kind = 'daily_overview'").get()).toEqual({ payload_json: JSON.stringify({ ownerId: 'm1', householdId: 'h1', localDate: '2026-01-01', timezone: 'America/New_York', consentRevision: 4, logicalRequest: 'daily-overview:m1:2026-01-01:America/New_York:4' }) });
    db.close();
  });
  it('enqueues one maintenance job on the first healthy tick without waiting for the morning window', () => {
    const db = new Database(':memory:'); migrate(db); const now = new Date('2026-01-01T00:02:00.000Z');
    db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString());
    db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Owner', 'America/New_York', 1, now.toISOString());
    db.prepare('INSERT INTO daily_ai_settings VALUES (?, 1, ?, 4, ?)').run('m1', 'daily-assistant-v1', now.toISOString());
    const queue = new JobQueue(db, () => now); const scheduler = new Scheduler(db, queue, new SourceRepository(db, keyFromSecret('secret'), () => now), () => now);
    scheduler.tick(); scheduler.tick();
    expect(db.prepare("SELECT kind, dedupe_key FROM jobs WHERE kind = 'daily_maintenance'").all()).toEqual([{ kind: 'daily_maintenance', dedupe_key: 'daily-maintenance:m1:2025-12-31:America/New_York:4' }]);
    db.close();
  });
});
it('schedules opted-in personal learning after 2am once a day without reviving a failed attempt',()=>{
  const db=new Database(':memory:');migrate(db);let now=new Date('2026-09-19T05:59:00Z');
  db.prepare('INSERT INTO households (id, created_at) VALUES (?,?)').run('h',now.toISOString());
  db.prepare("INSERT INTO members (id,household_id,access_subject,display_name,timezone,active,created_at) VALUES ('m','h','s','Owner','America/New_York',1,?)").run(now.toISOString());
  db.prepare("INSERT INTO daily_ai_settings VALUES ('m',1,'daily-assistant-v1',1,?)").run(now.toISOString());
  db.prepare("INSERT INTO personal_relevance VALUES ('m',1,1,'{}',?)").run(now.toISOString());
  const queue=new JobQueue(db,()=>now),scheduler=new Scheduler(db,queue,new SourceRepository(db,keyFromSecret('test')),()=>now);
  scheduler.tick();expect(db.prepare("SELECT id FROM jobs WHERE kind='relevance_learning'").all()).toHaveLength(0);
  now=new Date('2026-09-19T06:00:00Z');scheduler.tick();scheduler.tick();
  const job=queue.claim(['relevance_learning'])!;expect(job.payload).toMatchObject({ownerId:'m',localDate:'2026-09-19'});
  queue.fail(job,'TEST_FAILURE');scheduler.tick();expect(queue.get(job.id)?.state).toBe('failed');
  db.close();
});
it('does not revive terminal daily jobs on each scheduling tick',()=>{
  const db=new Database(':memory:');migrate(db);const now=new Date('2026-09-19T11:00:00Z');
  db.prepare("INSERT INTO households (id, created_at) VALUES ('h',?)").run(now.toISOString());
  db.prepare("INSERT INTO members (id,household_id,access_subject,display_name,timezone,active,created_at) VALUES ('m','h','s','Owner','America/New_York',1,?)").run(now.toISOString());
  db.prepare("INSERT INTO daily_ai_settings VALUES ('m',1,'daily-assistant-v1',1,?)").run(now.toISOString());db.prepare("INSERT INTO digest_settings VALUES ('m',1,'07:00',1,?)").run(now.toISOString());
  const queue=new JobQueue(db,()=>now),scheduler=new Scheduler(db,queue,new SourceRepository(db,keyFromSecret('test')),()=>now);scheduler.tick();
  db.prepare("UPDATE jobs SET state='failed',error_code='TEST' WHERE kind IN ('daily_overview','daily_maintenance')").run();scheduler.tick();
  expect(db.prepare("SELECT state FROM jobs WHERE kind IN ('daily_overview','daily_maintenance')").all()).toEqual([{state:'failed'},{state:'failed'}]);db.close();
});

it('never prepares one member’s brief twice at once', () => {
  const db = new Database(':memory:'); migrate(db); const now = new Date('2026-01-01T12:02:00.000Z');
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString());
  db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Owner', 'America/New_York', 1, now.toISOString());
  db.prepare('INSERT INTO digest_settings VALUES (?, 1, ?, 1, ?)').run('m1', '07:00', now.toISOString());
  db.prepare('INSERT INTO daily_ai_settings VALUES (?, 1, ?, 4, ?)').run('m1', 'daily-assistant-v1', now.toISOString());
  const queue = new JobQueue(db, () => now); const scheduler = new Scheduler(db, queue, new SourceRepository(db, keyFromSecret('secret'), () => now), () => now);
  const manual = queue.enqueue({ kind: 'daily_overview', scopeId: 'daily:m1', dedupeKey: 'daily-overview:manual:m1', payload: { ownerId: 'm1' } });
  scheduler.tick();
  expect(db.prepare("SELECT count(*) AS count FROM jobs WHERE kind = 'daily_overview'").get()).toEqual({ count: 1 });
  expect(queue.claim(['daily_overview'])?.id).toBe(manual.id);
  // Another queued brief for the same member waits while one is running.
  queue.enqueue({ kind: 'daily_overview', scopeId: 'daily:m1', dedupeKey: 'daily-overview:other', payload: { ownerId: 'm1' } });
  expect(queue.claim(['daily_overview'])).toBeUndefined();
  db.close();
});
