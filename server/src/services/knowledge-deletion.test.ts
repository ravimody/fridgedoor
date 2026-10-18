import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { keyFromSecret } from '../crypto.js';
import { FakeGoogleProvider } from '../providers/google.js';
import { KnowledgeRepository } from '../repos/knowledge.js';
import { ConnectionService } from './connections.js';

it('private-data deletion purges active knowledge and encrypted change history', () => {
  const db = new Database(':memory:');
  migrate(db);
  const now = new Date('2026-03-08T16:00:00.000Z').toISOString();
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now);
  db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run('m1', 'h1', 's1', 'Owner', 'America/New_York', now);
  const key = keyFromSecret('knowledge-deletion-test');
  new KnowledgeRepository(db, key, () => new Date(now)).set({ memberId: 'm1', householdId: 'h1' }, { key: 'school', value: 'Example school', expectedRevision: 0 });
  const service = new ConnectionService(db, key, new FakeGoogleProvider(), 'https://planner.example.test');
  expect(service.deletePrivateData('m1')).toEqual({ deleted: true });
  expect(db.prepare('SELECT count(*) AS count FROM assistant_knowledge WHERE owner_id = ?').get('m1')).toEqual({ count: 0 });
  expect(db.prepare('SELECT count(*) AS count FROM knowledge_changes WHERE owner_id = ?').get('m1')).toEqual({ count: 0 });
  db.close();
});
