import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { encryptJson, keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import type { PlanFacts } from '@fridgedoor/contracts';
import { PlanRepository } from './plans.js';

const now = new Date('2026-01-01T00:00:00.000Z'); const key = keyFromSecret('plans-test-secret');
const facts = (location = 'Library'): PlanFacts => ({ title: 'School pickup', category: 'school', participants: ['Alex'], time: { kind: 'all_day', startDate: '2026-01-01', endDateExclusive: '2026-01-02' }, location, preparationTasks: [], unresolvedFields: [] });
function seed() { const db = new Database(':memory:'); migrate(db); db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString()); for (const member of [['m1', 'Alex'], ['m2', 'Sam']]) db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(member[0], 'h1', `subject-${member[0]}`, member[1], 'America/New_York', 1, now.toISOString()); for (const [id, owner, text] of [['v1', 'm1', 'School pickup'], ['v2', 'm1', 'School pickup again'], ['v3', 'm2', 'School pickup from Sam']]) { const source = `s-${id}`; db.prepare('INSERT INTO source_items (id, household_id, owner_id, connection_id, kind, provider_key, encrypted_provider_refs, state, generation, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)').run(source, 'h1', owner, 'capture', id, '{}', 'available', 1, now.toISOString(), now.toISOString()); db.prepare('INSERT INTO source_versions (id, source_id, sequence, content_digest, encrypted_evidence, observed_at, expires_at, availability, metadata_json) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)').run(id, source, id, JSON.stringify(encryptJson({ providerId: id, labels: [], text, attachmentsIncomplete: false }, key, `source-version:${id}`)), now.toISOString(), '2026-01-08T00:00:00.000Z', 'available', '{}'); } return db; }
describe('plan repository', () => {
  it('deduplicates eligible copies but keeps private evidence private', () => { const db = seed(); const repo = new PlanRepository(db, key, () => now); const shared1 = repo.upsertExtraction({ id: 'x1', sourceVersionId: 'v1', ownerId: 'm1', householdId: 'h1', visibility: 'shared', facts: facts(), relation: 'new', evidenceRole: 'supporting' }); const shared2 = repo.upsertExtraction({ id: 'x2', sourceVersionId: 'v3', ownerId: 'm2', householdId: 'h1', visibility: 'shared', facts: facts(), relation: 'new', evidenceRole: 'supporting' }); expect(shared2).toBe(shared1); const privateId = repo.upsertExtraction({ id: 'x3', sourceVersionId: 'v2', ownerId: 'm1', householdId: 'h1', visibility: 'private', facts: facts(), relation: 'new', evidenceRole: 'supporting' }); expect(privateId).not.toBe(shared1); expect(repo.list('m2')).toHaveLength(1); expect(repo.list('m1')).toHaveLength(2); });
  it('leaves accepted facts unchanged while a material correction is pending', () => { const db = seed(); const repo = new PlanRepository(db, key, () => now); const id = repo.upsertExtraction({ id: 'x1', sourceVersionId: 'v1', ownerId: 'm1', householdId: 'h1', visibility: 'shared', facts: facts(), relation: 'new', evidenceRole: 'supporting' }); db.prepare("UPDATE plans SET status = 'accepted' WHERE id = ?").run(id); const corrected = repo.upsertExtraction({ id: 'x2', sourceVersionId: 'v2', ownerId: 'm1', householdId: 'h1', visibility: 'shared', facts: facts('Gym'), relation: 'update', evidenceRole: 'correction' }); expect(corrected).toBe(id); const after = repo.detail(id, 'm1'); expect(after.facts.location).toBe('Library'); expect(after.pendingFacts?.location).toBe('Gym'); });
  it('does not resurface an identical dismissed replay', () => { const db = seed(); const repo = new PlanRepository(db, key, () => now); const id = repo.upsertExtraction({ id: 'x1', sourceVersionId: 'v1', ownerId: 'm1', householdId: 'h1', visibility: 'shared', facts: facts(), relation: 'new', evidenceRole: 'supporting' }); const detail = repo.detail(id, 'm1'); repo.dismiss(id, 'm1', detail.revision); repo.upsertExtraction({ id: 'x2', sourceVersionId: 'v2', ownerId: 'm1', householdId: 'h1', visibility: 'shared', facts: facts(), relation: 'new', evidenceRole: 'supporting' }); expect(repo.detail(id, 'm1').status).toBe('dismissed'); });
});
it('enforces expiry and member revocation before decrypting retained source evidence',()=>{
  const db=seed(),repo=new PlanRepository(db,key,()=>now);
  const id=repo.upsertExtraction({id:'test',sourceVersionId:'v1',ownerId:'m1',householdId:'h1',visibility:'shared',facts:facts(),relation:'new',evidenceRole:'supporting'});
  expect(repo.evidence(id,'m1')).toMatchObject({availability:'available',text:'School pickup'});
  db.prepare("UPDATE source_versions SET expires_at=?,encrypted_evidence='invalid-ciphertext' WHERE id='v1'").run(now.toISOString());
  expect(repo.evidence(id,'m1')).toMatchObject({availability:'expired'});expect(repo.evidence(id,'m1')).not.toHaveProperty('text');
  db.prepare("UPDATE members SET active=0 WHERE id='m1'").run();
  expect(()=>repo.evidence(id,'m1')).toThrow('NOT_FOUND');expect(repo.list('m1')).toEqual([]);db.close();
});
it('withdraws source evidence immediately when its source or connection is revoked',()=>{
  const db=seed(),repo=new PlanRepository(db,key,()=>now);
  const id=repo.upsertExtraction({id:'test',sourceVersionId:'v1',ownerId:'m1',householdId:'h1',visibility:'shared',facts:facts(),relation:'new',evidenceRole:'supporting'});
  db.prepare("UPDATE source_items SET state='disconnected' WHERE id='s-v1'").run();expect(repo.evidence(id,'m1')).not.toHaveProperty('text');
  db.prepare("INSERT INTO google_connections (id,member_id,google_sub,email,grants_json,encrypted_tokens,status,generation,disclosure_version,consented_at,created_at,updated_at) VALUES ('c','m1','g','test@example.test','[]','{}','active',2,'v1',?,?,?)").run(now.toISOString(),now.toISOString(),now.toISOString());
  db.prepare("UPDATE source_items SET state='available',connection_id='c' WHERE id='s-v1'").run();expect(repo.evidence(id,'m1')).not.toHaveProperty('text');
  db.prepare("UPDATE google_connections SET generation=1").run();expect(repo.evidence(id,'m1')).toHaveProperty('text');
  db.prepare("UPDATE google_connections SET status='paused'").run();expect(repo.evidence(id,'m1')).not.toHaveProperty('text');db.close();
});
