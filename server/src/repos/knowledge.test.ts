import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { decryptJson, encryptJson, keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { KnowledgeRepository } from './knowledge.js';

const key = keyFromSecret('knowledge-repository-test');
const first = new Date('2026-03-08T16:00:00.000Z');
const actor = { memberId: 'm1', householdId: 'h1' };
const other = { memberId: 'm2', householdId: 'h1' };

function setup() {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', first.toISOString());
  for (const [id, subject] of [['m1', 's1'], ['m2', 's2']]) db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(id, 'h1', subject, id, 'America/New_York', first.toISOString());
  return db;
}

describe('knowledge repository', () => {
  it('reads legacy rows without rewriting their encrypted value', () => {
    const db = setup();
    const encrypted = JSON.stringify(encryptJson('Elementary school', key, 'knowledge:m1:school'));
    db.prepare('INSERT INTO assistant_knowledge (owner_id, fact_key, encrypted_value, updated_at) VALUES (?, ?, ?, ?)').run('m1', 'school', encrypted, first.toISOString());
    const repo = new KnowledgeRepository(db, key, () => first);
    expect(repo.list(actor)).toMatchObject([{ key: 'school', value: 'Elementary school', revision: 1, provenance: 'legacy', confirmation: 'unconfirmed' }]);
    expect((db.prepare('SELECT encrypted_value FROM assistant_knowledge WHERE owner_id = ?').get('m1') as { encrypted_value: string }).encrypted_value).toBe(encrypted);
    expect(repo.list(other)).toEqual([]);
    db.close();
  });

  it('uses compare and swap revisions and records encrypted before and after values', () => {
    const db = setup();
    const repo = new KnowledgeRepository(db, key, () => first);
    expect(repo.set(actor, { key: 'home_area', value: 'Old town', expectedRevision: 0 })).toMatchObject({ revision: 1, provenance: 'user' });
    expect(() => repo.set(actor, { key: 'home_area', value: 'Wrong write', expectedRevision: 0 })).toThrow('STALE_REVISION');
    expect(repo.set(actor, { key: 'home_area', value: 'New town', expectedRevision: 1, sourceManifest: ['source-1'] })).toMatchObject({ value: 'New town', revision: 2 });
    const row = db.prepare('SELECT encrypted_value FROM assistant_knowledge WHERE owner_id = ? AND fact_key = ?').get('m1', 'home_area') as { encrypted_value: string };
    expect(decryptJson<string>(JSON.parse(row.encrypted_value), key, 'knowledge:m1:home_area')).toBe('New town');
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_changes').all())).not.toContain('source-1');
    expect(repo.history(actor, 'home_area')).toMatchObject([
      { baseRevision: 1, resultRevision: 2, before: 'Old town', after: 'New town' },
      { baseRevision: 0, resultRevision: 1, before: null, after: 'Old town' },
    ]);
    expect(() => repo.history(other, 'home_area')).not.toThrow();
    db.close();
  });

  it('filters expired facts and labels future facts in bounded context', () => {
    const db = setup();
    const repo = new KnowledgeRepository(db, key, () => first);
    repo.set(actor, { key: 'current', value: 'Now', expectedRevision: 0, validFrom: '2026-03-08', validUntil: '2026-03-12' });
    repo.set(actor, { key: 'future', value: 'Soon', expectedRevision: 0, validFrom: '2026-03-10' });
    repo.set(actor, { key: 'past', value: 'Gone', expectedRevision: 0, validUntil: '2026-03-08' });
    expect(repo.context(actor, '2026-03-08', '2026-03-16')).toMatchObject([
      { key: 'current', validity: 'current' },
      { key: 'future', validity: 'future' },
    ]);
    db.close();
  });

  it('undoes only the current revision and forget purges the value history', () => {
    const db = setup();
    const repo = new KnowledgeRepository(db, key, () => first);
    const created = repo.set(actor, { key: 'diet', value: 'Vegetarian', expectedRevision: 0 });
    expect(repo.undo(actor, repo.history(actor, 'diet')[0]!.id, created.revision)).toEqual({ undone: true, revision: 2 });
    expect(repo.list(actor)).toEqual([]);
    expect(() => repo.undo(actor, repo.history(actor, 'diet')[0]!.id, 2)).toThrow('STALE_REVISION');
    repo.set(actor, { key: 'diet', value: 'Vegan', expectedRevision: 0 });
    expect(repo.forget(actor, 'diet', 1)).toEqual({ deleted: true });
    expect(repo.history(actor, 'diet')).toEqual([]);
    db.close();
  });

  it('keeps the active limit, rejects oversized writes atomically, and treats a renamed key as a new fact', () => {
    const db = setup();
    const repo = new KnowledgeRepository(db, key, () => first);
    expect(() => repo.set(actor, { key: 'too-long', value: 'x'.repeat(501), expectedRevision: 0 })).toThrow('INVALID_FACT');
    expect(repo.list(actor)).toEqual([]);
    repo.set(actor, { key: 'old_name', value: 'unchanged', expectedRevision: 0 });
    repo.set(actor, { key: 'new_name', value: 'renamed', expectedRevision: 0 });
    for (let index = 0; index < 48; index++) repo.set(actor, { key: `fact_${index}`, value: 'value', expectedRevision: 0 });
    expect(() => repo.set(actor, { key: 'fact_49', value: 'value', expectedRevision: 0 })).toThrow('KNOWLEDGE_LIMIT');
    expect(repo.list(actor)).toHaveLength(50);
    expect(repo.get(actor, 'old_name')?.value).toBe('unchanged');
    expect(repo.get(actor, 'new_name')?.value).toBe('renamed');
    db.close();
  });

  it('archives an expired fact and restores it through its maintenance Undo', () => {
    const db = setup();
    const repo = new KnowledgeRepository(db, key, () => first);
    repo.set(actor, { key: 'temporary', value: 'Until Friday', expectedRevision: 0, validUntil: '2026-03-01', confirmation: 'confirmed' });
    const archived = repo.archive(actor, 'temporary', 1);
    expect(archived).toEqual({ archived: true, revision: 2 });
    expect(repo.list(actor)).toEqual([]);
    const change = repo.history(actor, 'temporary')[0]!;
    expect(change.origin).toBe('maintenance');
    expect(repo.undo(actor, change.id, 2)).toEqual({ undone: true, revision: 3 });
    expect(repo.get(actor, 'temporary')).toMatchObject({ value: 'Until Friday', revision: 3, archivedAt: null });
    db.close();
  });
});
