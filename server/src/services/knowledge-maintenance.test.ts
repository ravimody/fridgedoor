import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { KnowledgeMaintenanceOutput } from '@fridgedoor/contracts';
import { keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { KnowledgeRepository } from '../repos/knowledge.js';
import { KnowledgeMaintenanceService } from './knowledge-maintenance.js';
import type { KnowledgeMaintenanceProvider } from '../ai/knowledge-maintenance.js';

const now = new Date('2026-03-08T16:00:00.000Z');
const actor = { memberId: 'm1', householdId: 'h1' };
const key = keyFromSecret('knowledge-maintenance-test');

function setup() {
  const db = new Database(':memory:'); migrate(db);
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString());
  db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run('m1', 'h1', 's1', 'Owner', 'America/New_York', now.toISOString());
  return db;
}

function provider(result: KnowledgeMaintenanceOutput): KnowledgeMaintenanceProvider {
  return { generate: async () => ({ result, usage: { inputTokens: 1, outputTokens: 1 }, provider: 'test', model: 'test' }) };
}

describe('knowledge maintenance', () => {
  it('archives only confirmed expired facts and restores them with Undo', async () => {
    const db = setup(); const repo = new KnowledgeRepository(db, key, () => now);
    repo.set(actor, { key: 'stable', value: 'Keep', expectedRevision: 0, confirmation: 'confirmed' });
    repo.set(actor, { key: 'future', value: 'Soon', expectedRevision: 0, confirmation: 'confirmed', validFrom: '2026-04-01' });
    repo.set(actor, { key: 'expired', value: 'Gone', expectedRevision: 0, confirmation: 'confirmed', validUntil: '2026-03-08' });
    repo.set(actor, { key: 'unconfirmed', value: 'Keep too', expectedRevision: 0, confirmation: 'unconfirmed', validUntil: '2026-03-08' });
    const service = new KnowledgeMaintenanceService(db, key, undefined, 'test', () => now);
    await service.maintain(actor, 'maintenance-test');
    expect(repo.list(actor).map((fact) => fact.key)).toEqual(['future', 'stable', 'unconfirmed']);
    const change = repo.history(actor, 'expired')[0]!;
    expect(repo.undo(actor, change.id, 2)).toEqual({ undone: true, revision: 3 });
    expect(repo.get(actor, 'expired')?.value).toBe('Gone');
    db.close();
  });

  it('keeps semantic duplicates reviewable while preserving qualified facts', async () => {
    const db = setup(); const repo = new KnowledgeRepository(db, key, () => now);
    repo.set(actor, { key: 'school', value: 'Maple Grove Elementary', expectedRevision: 0, provenance: 'source', confirmation: 'confirmed', validFrom: '2026-01-01', validUntil: '2027-01-01' });
    repo.set(actor, { key: 'school_name', value: '  maple grove   elementary ', expectedRevision: 0, provenance: 'source', confirmation: 'confirmed', validFrom: '2026-01-01', validUntil: '2027-01-01' });
    repo.set(actor, { key: 'school_next_year', value: 'Maple Grove Elementary', expectedRevision: 0, provenance: 'source', confirmation: 'confirmed', validFrom: '2027-01-01' });
    const service = new KnowledgeMaintenanceService(db, key, undefined, 'test', () => now);
    const result = await service.maintain(actor, 'maintenance-test');
    expect(result.deduplicated).toBe(0);
    expect(repo.list(actor).map((fact) => fact.key)).toEqual(['school', 'school_name', 'school_next_year']);
    db.close();
  });

  it('stores only source-authorized proposals and suppresses dismissed duplicates', async () => {
    const db = setup();
    const result: KnowledgeMaintenanceOutput = { proposals: [
      { operation: 'add', targetKeys: ['favorite_food'], baseRevisions: [0], proposedValue: 'Pasta', provenanceRefs: ['mail-1'], reason: 'The source states this preference.' },
      { operation: 'add', targetKeys: ['secret'], baseRevisions: [0], proposedValue: 'Do not store', provenanceRefs: ['not-authorized'], reason: 'Untrusted source.' },
    ] };
    const service = new KnowledgeMaintenanceService(db, key, provider(result), 'test', () => now);
    const first = await service.maintain(actor, 'maintenance-test', [{ ref: 'mail-1', summary: 'Synthetic source' }]);
    expect(first.proposals).toHaveLength(1);
    const proposal = first.proposals[0]!;
    expect(service.dismiss(actor, proposal.id)).toEqual({ dismissed: true });
    const second = await service.maintain(actor, 'maintenance-test', [{ ref: 'mail-1', summary: 'Synthetic source' }]);
    expect(second.proposals).toEqual([]);
    expect(service.list(actor)).toEqual([]);
    db.close();
  });

  it('refuses to accept a proposal after it expires', async () => {
    const db = setup(); let clock = now; const repo = new KnowledgeRepository(db, key, () => clock);
    const service = new KnowledgeMaintenanceService(db, key, provider({ proposals: [{ operation: 'add', targetKeys: ['favorite_food'], baseRevisions: [0], proposedValue: 'Pasta', provenanceRefs: ['mail-1'], reason: 'The source states this preference.' }] }), 'test', () => clock);
    const proposal = (await service.maintain(actor, 'maintenance-test', [{ ref: 'mail-1' }])).proposals[0]!;
    clock = new Date(Date.parse(proposal.expiresAt) + 1000);
    expect(() => service.accept(actor, proposal.id)).toThrow('PROPOSAL_EXPIRED');
    expect(repo.get(actor, 'favorite_food')).toBeUndefined();
    db.close();
  });

  it('does not resurrect a forgotten fact from unchanged evidence', async () => {
    const db = setup(); const repo = new KnowledgeRepository(db, key, () => now);
    repo.set(actor, { key: 'diet', value: 'Vegetarian', expectedRevision: 0 });
    repo.forget(actor, 'diet', 1);
    const service = new KnowledgeMaintenanceService(db, key, provider({ proposals: [{ operation: 'add', targetKeys: ['diet'], baseRevisions: [0], proposedValue: 'Vegetarian', provenanceRefs: ['mail-1'], reason: 'Old source repeats the forgotten fact.' }] }), 'test', () => now);
    const proposal = (await service.maintain(actor, 'maintenance-test', [{ ref: 'mail-1' }])).proposals[0]!;
    expect(() => service.accept(actor, proposal.id)).toThrow('FORGOTTEN_FACT');
    expect(repo.get(actor, 'diet')).toBeUndefined();
    db.close();
  });
});
