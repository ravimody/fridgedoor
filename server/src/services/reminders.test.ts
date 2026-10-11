import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { keyFromSecret } from '../crypto.js';
import { FakePushProvider, validatePushEndpoint } from '../providers/push.js';
import { ReminderService } from './reminders.js';

const now = new Date('2026-01-01T12:00:00.000Z');
function seed() { const db = new Database(':memory:'); migrate(db); db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString()); db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Alex', 'America/New_York', 1, now.toISOString()); db.prepare("INSERT INTO list_items (id, household_id, kind, title, created_by, created_at, updated_at) VALUES ('item-1', 'h1', 'todo', 'Synthetic task', 'm1', ?, ?)").run(now.toISOString(), now.toISOString()); return db; }
describe('reminders', () => {
  it('delivers a due reminder once per subscription and replays safely', async () => { const db = seed(); const push = new FakePushProvider(); const service = new ReminderService(db, keyFromSecret('reminder-secret'), push, () => now); const actor = { memberId: 'm1', householdId: 'h1' }; service.subscribe(actor, { endpoint: 'https://fcm.googleapis.com/fcm/send/example', p256dh: 'p256dh', auth: 'auth', label: 'Phone' }); const reminder = service.create(actor, { parentType: 'list_item', parentId: 'item-1', recipientId: 'm1', dueAt: now.toISOString(), timezone: 'America/New_York' }); expect((await service.deliverDue()).sent).toBe(1); expect((await service.deliverDue()).sent).toBe(0); expect(push.sent).toHaveLength(1); expect(service.update(actor, reminder.id, 1, { snoozeUntil: '2026-01-01T13:00:00.000Z' }).revision).toBe(2); expect(() => service.update(actor, reminder.id, 1, { completed: true })).toThrow('STALE_REVISION'); });
  it('rejects private or unsupported push endpoints', () => { expect(() => validatePushEndpoint('http://127.0.0.1:8080/push')).toThrow('INVALID_PUSH_ENDPOINT'); expect(() => validatePushEndpoint('https://example.com/push')).toThrow('INVALID_PUSH_ENDPOINT'); });
});

it('checks parent access, deduplicates retries, and normalizes reminder timestamps', () => {
  const db = seed(); const service = new ReminderService(db, keyFromSecret('reminder-secret'), new FakePushProvider(), () => now); const actor = { memberId: 'm1', householdId: 'h1' };
  const input = { parentType: 'list_item', parentId: 'item-1', recipientId: 'm1', dueAt: '2026-01-01T08:00:00-05:00', timezone: 'America/New_York' };
  expect(() => service.create(actor, { ...input, parentId: 'someone-elses-item' })).toThrow('NOT_FOUND');
  const result = service.create(actor, input, 'one');
  expect(result.dueAt).toBe('2026-01-01T13:00:00.000Z');
  expect(service.create(actor, input, 'one').id).toBe(result.id);
  expect(db.prepare('SELECT count(*) n FROM reminders').get()).toEqual({ n: 1 });
  expect(() => service.create(actor, { ...input, dueAt: '2026-01-02T08:00:00-05:00' }, 'one')).toThrow('IDEMPOTENCY_CONFLICT');
});
it('does not send for a completed parent or a disabled member', async () => {
  for (const change of ["UPDATE list_items SET completed_at = '2026-01-01'", 'UPDATE members SET active = 0']) {
    const db = seed(); const push = new FakePushProvider(); const service = new ReminderService(db, keyFromSecret('reminder-secret'), push, () => now); const actor = { memberId: 'm1', householdId: 'h1' };
    service.subscribe(actor, { endpoint: 'https://fcm.googleapis.com/fcm/send/example', p256dh: 'p256dh', auth: 'auth', label: 'Phone' });
    service.create(actor, { parentType: 'list_item', parentId: 'item-1', recipientId: 'm1', dueAt: now.toISOString(), timezone: 'America/New_York' });
    db.exec(change); await service.deliverDue(); expect(push.sent).toHaveLength(0);
    expect(db.prepare('SELECT state FROM reminders').get()).toEqual({ state: 'canceled' });
  }
});
it('retries uncertain delivery with the same tag and stops after acceptance', async () => {
  const db = seed(); let clock = now; let calls = 0; const tags: string[] = [];
  const service = new ReminderService(db, keyFromSecret('reminder-secret'), { send: async (_subscription, payload) => { tags.push(payload.tag); calls++; return calls === 1 ? 'retry' : 'accepted'; } }, () => clock);
  const actor = { memberId: 'm1', householdId: 'h1' };
  service.subscribe(actor, { endpoint: 'https://fcm.googleapis.com/fcm/send/example', p256dh: 'p256dh', auth: 'auth', label: 'Phone' });
  service.create(actor, { parentType: 'list_item', parentId: 'item-1', recipientId: 'm1', dueAt: now.toISOString(), timezone: 'America/New_York' });
  await service.deliverDue(); await service.deliverDue(); expect(calls).toBe(1);
  clock = new Date(now.getTime() + 61000); await service.deliverDue(); await service.deliverDue();
  expect(calls).toBe(2); expect(tags[0]).toBe(tags[1]); expect(db.prepare('SELECT state, attempts FROM reminder_deliveries').get()).toEqual({ state: 'accepted', attempts: 2 });
});

it('follows a corrected private deadline and cancels its reminder when dismissed', async () => {
  const { PlanRepository } = await import('../repos/plans.js');
  const db = seed(); const key = keyFromSecret('reminder-secret'); const actor = { memberId: 'm1', householdId: 'h1' };
  const plans = new PlanRepository(db, key, () => now); const push = new FakePushProvider();
  const service = new ReminderService(db, key, push, () => now);
  const facts = { title: 'Permission slip due', category: 'school', participants: [], preparationTasks: [], unresolvedFields: [], time: { kind: 'deadline' as const, at: '2026-01-01T08:00:00-05:00', timezone: 'America/New_York' } };
  const id = plans.createPrivate(actor, facts);
  service.subscribe(actor, { endpoint: 'https://fcm.googleapis.com/fcm/send/example', p256dh: 'p256dh', auth: 'auth', label: 'Phone' });
  const reminder = service.create(actor, { parentType: 'plan', parentId: id, recipientId: 'm1', dueAt: now.toISOString(), timezone: 'America/New_York', offsetMinutes: -60 });
  expect(reminder.dueAt).toBe(now.toISOString());
  plans.edit(id, 'm1', 1, { ...facts, time: { ...facts.time, at: '2026-01-01T09:00:00-05:00' } });
  await service.deliverDue();
  expect(push.sent).toHaveLength(0);
  expect(service.list(actor)[0]).toMatchObject({ dueAt: '2026-01-01T13:00:00.000Z', revision: 2 });
  plans.dismiss(id, 'm1', 2);
  await service.deliverDue();
  expect(db.prepare('SELECT state FROM reminders').get()).toEqual({ state: 'canceled' });
});
