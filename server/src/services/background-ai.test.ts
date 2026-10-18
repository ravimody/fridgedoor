import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { BackgroundAiService } from './background-ai.js';
function setup() {
  const db = new Database(':memory:'); migrate(db); const now = new Date('2026-09-12T12:00:00Z');
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h', now.toISOString());
  for (const id of ['a','b']) db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(id, 'h', id, id, 'America/New_York', now.toISOString());
  return { db, now, actor: { memberId: 'a', householdId: 'h' }, service: new BackgroundAiService(db, true, () => now) };
}
describe('background AI settings', () => {
  it('defaults off, keeps consent per member, rejects stale updates and disabled members', () => {
    const { db, actor, service } = setup();
    expect(service.status(actor).enabled).toBe(false);
    expect(service.set(actor, true, 0)).toMatchObject({ enabled: true, revision: 1 });
    expect(service.status({ memberId: 'b', householdId: 'h' }).enabled).toBe(false);
    expect(() => service.set(actor, false, 0)).toThrow('STALE_REVISION');
    expect(service.set(actor, false, 1).enabled).toBe(false);
    db.prepare('UPDATE members SET active = 0 WHERE id = ?').run('a');
    expect(() => service.set(actor, true, 2)).toThrow('NOT_FOUND');
  });
  it('allows disabling while the provider is unavailable', () => {
    const { db, actor, now, service } = setup(); service.set(actor, true, 0);
    const unavailable = new BackgroundAiService(db, false, () => now);
    expect(unavailable.set(actor, false, 1).enabled).toBe(false);
    expect(() => unavailable.set(actor, true, 2)).toThrow('UNAVAILABLE');
  });
});

it('names the AI provider by its preset label so every member can see who reads their email', () => {
  const { db, now, actor } = setup();
  expect(new BackgroundAiService(db, true, () => now, () => ({ provider: 'anthropic', model: 'claude-haiku' })).status(actor)).toMatchObject({ provider: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-haiku' });
  expect(new BackgroundAiService(db, true, () => now, () => ({ provider: 'my-own', model: 'x' })).status(actor)).toMatchObject({ provider: 'my-own', providerLabel: null });
});
