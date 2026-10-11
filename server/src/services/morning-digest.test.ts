import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/migrate.js';
import { keyFromSecret } from '../crypto.js';
import { FakePushProvider, type PushProvider } from '../providers/push.js';
import { ReminderService } from './reminders.js';
import { MorningDigestService } from './morning-digest.js';
function setup(instant = '2026-09-12T10:59:00Z', push: PushProvider = new FakePushProvider()) {
  const db = new Database(':memory:'); migrate(db); let now = new Date(instant); const key = keyFromSecret('test-only');
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h', now.toISOString());
  for (const id of ['a','b']) db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(id, 'h', id, id, 'America/New_York', now.toISOString());
  const actor = { memberId: 'a', householdId: 'h' }; const reminders = new ReminderService(db, key, push, () => now);
  const subscribe = (id: string, device = id) => reminders.subscribe({ ...actor, memberId: id }, { endpoint: `https://fcm.googleapis.com/${device}`, p256dh: 'synthetic', auth: 'synthetic', label: device });
  const service = new MorningDigestService(db, key, push, true, () => now);
  return { db, key, push, actor, service, subscribe, clock: (time: string) => { now = new Date(time); } };
}
describe('morning notification delivery', () => {
  it('defaults off and preserves per-member settings with revision checks', () => {
    const { service, actor, db } = setup();
    expect(service.status(actor)).toMatchObject({ enabled: false, localTime: '07:00', revision: 0, devices: 0 });
    service.set(actor, { enabled: true, localTime: '08:30', expectedRevision: 0 });
    expect(service.status({ ...actor, memberId: 'b' }).enabled).toBe(false);
    expect(() => service.set(actor, { enabled: false, localTime: '07:00', expectedRevision: 0 })).toThrow('STALE_REVISION');
    expect(() => service.set(actor, { enabled: true, localTime: '24:00', expectedRevision: 1 })).toThrow('INVALID_DIGEST_TIME');
    db.prepare("UPDATE members SET active = 0 WHERE id = 'a'").run();
    expect(() => service.status(actor)).toThrow('NOT_FOUND');
  });
  it('sends once per local day/device, independently of Google or AI', async () => {
    const { service, actor, subscribe, clock, push } = setup(); subscribe('a'); subscribe('b');
    service.set(actor, { enabled: true, localTime: '07:00', expectedRevision: 0 });
    expect(await service.deliverDue()).toEqual({ sent: 0 });
    clock('2026-09-12T11:00:00Z'); expect(await service.deliverDue()).toEqual({ sent: 1 });
    expect(await service.deliverDue()).toEqual({ sent: 0 });
    expect((push as FakePushProvider).sent[0]?.payload).toEqual({ title: 'Fridgedoor morning digest', url: '/dashboard/', tag: 'digest-a-2026-09-12' });
    clock('2026-09-13T11:00:00Z'); expect(await service.deliverDue()).toEqual({ sent: 1 });
    expect(service.status(actor).lastDelivery).toMatchObject({ date: '2026-09-13', accepted: 1 });
  });
  it.each([
    ['2026-11-01T05:30:00Z', '01:30', '2026-11-01T06:30:00Z'],
    ['2026-03-08T07:30:00Z', '02:30', '2026-03-08T08:30:00Z'],
  ])('handles DST at %s without duplicate delivery', async (instant, localTime, later) => {
    const { service, actor, subscribe, clock } = setup(instant); subscribe('a');
    service.set(actor, { enabled: true, localTime, expectedRevision: 0 });
    expect(await service.deliverDue()).toEqual({ sent: 1 });
    clock(later); expect(await service.deliverDue()).toEqual({ sent: 0 });
  });
  it('expires missed deliveries after four hours and never carries them across local midnight', async () => {
    const { service, actor, subscribe, clock } = setup('2026-09-12T15:01:00Z'); subscribe('a');
    service.set(actor, { enabled: true, localTime: '07:00', expectedRevision: 0 });
    expect(await service.deliverDue()).toEqual({ sent: 0 });
    service.set(actor, { enabled: true, localTime: '23:30', expectedRevision: 1 });
    clock('2026-09-13T04:01:00Z'); expect(await service.deliverDue()).toEqual({ sent: 0 });
  });
  it('bounds retries, uses stable tags, and does not duplicate an in-flight claim', async () => {
    const send = vi.fn().mockResolvedValue('retry');
    const { service, actor, subscribe, clock } = setup('2026-09-12T11:00:00Z', { send }); subscribe('a');
    service.set(actor, { enabled: true, localTime: '07:00', expectedRevision: 0 });
    await Promise.all([service.deliverDue(), service.deliverDue()]); expect(send).toHaveBeenCalledTimes(1);
    clock('2026-09-12T11:01:00Z'); await service.deliverDue();
    clock('2026-09-12T11:03:00Z'); await service.deliverDue();
    clock('2026-09-12T11:10:00Z'); await service.deliverDue(); expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(send.mock.calls.map((call) => call[1].tag)).size).toBe(1);
  });
  it('rechecks opt-out between devices and prevents same-day replay after re-enabling', async () => {
    const send = vi.fn().mockImplementation(async () => { service.set(actor, { enabled: false, localTime: '07:00', expectedRevision: 1 }); return 'accepted'; });
    const { service, actor, subscribe, clock } = setup('2026-09-12T11:00:00Z', { send }); subscribe('a', 'one'); subscribe('a', 'two');
    service.set(actor, { enabled: true, localTime: '07:00', expectedRevision: 0 });
    await service.deliverDue(); expect(send).toHaveBeenCalledTimes(1);
    service.set(actor, { enabled: true, localTime: '07:00', expectedRevision: 2 });
    clock('2026-09-12T11:01:00Z'); await service.deliverDue(); expect(send).toHaveBeenCalledTimes(1);
  });
  it('disables gone endpoints and excludes disabled members', async () => {
    const send = vi.fn().mockResolvedValue('gone'); const { service, actor, subscribe, db } = setup('2026-09-12T11:00:00Z', { send }); subscribe('a');
    service.set(actor, { enabled: true, localTime: '07:00', expectedRevision: 0 });
    db.prepare("UPDATE members SET active = 0 WHERE id = 'a'").run(); await service.deliverDue(); expect(send).not.toHaveBeenCalled();
    db.prepare("UPDATE members SET active = 1 WHERE id = 'a'").run(); await service.deliverDue(); expect(service.status(actor).devices).toBe(0);
  });
});
