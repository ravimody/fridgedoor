import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptJson, indexKey, keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { JobQueue } from '../jobs/queue.js';
import { CalendarRepository } from '../repos/calendar.js';
import { FakeGoogleProvider, GOOGLE_SCOPES, type GoogleGrant } from '../providers/google.js';
import { CalendarSync } from './calendar.js';

const grant: GoogleGrant = { sub: 'g1', email: 'alex@example.test', scopes: [...GOOGLE_SCOPES], accessToken: 'a', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z' };
const timed = (id: string, start = '2026-01-10T09:00:00-05:00', end = '2026-01-10T10:00:00-05:00') => ({ id, status: 'confirmed' as const, summary: `Event ${id}`, start: { dateTime: start, timeZone: 'America/New_York' }, end: { dateTime: end, timeZone: 'America/New_York' } });
describe('calendar ingestion', () => {
  let db: Database.Database; let now: Date; let queue: JobQueue; let repo: CalendarRepository;
  beforeEach(() => { db = new Database(':memory:'); migrate(db); now = new Date('2026-01-01T00:00:00.000Z'); db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString()); db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Alex', 'America/New_York', 1, now.toISOString()); db.prepare('INSERT INTO google_connections (id, member_id, google_sub, email, grants_json, encrypted_tokens, status, generation, disclosure_version, consented_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('c1', 'm1', 'g1', grant.email, '[]', JSON.stringify(encryptJson(grant, keyFromSecret('secret'), 'google-connection:c1')), 'active', 1, 'v1', now.toISOString(), now.toISOString(), now.toISOString()); const calendarKey = indexKey('cal1', keyFromSecret('secret')); db.prepare('INSERT INTO calendar_selections (id, connection_id, generation, encrypted_calendar_id, calendar_key, selected, classification, provider_access_role, display_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('sel1', 'c1', 1, JSON.stringify(encryptJson({ id: 'cal1' }, keyFromSecret('secret'), `calendar:c1:${calendarKey}`)), calendarKey, 1, 'household', 'owner', 'Household'); queue = new JobQueue(db, () => now); repo = new CalendarRepository(db, keyFromSecret('secret'), () => now); });
  it('commits the sync token after pages and preserves moved recurring identity', async () => { const provider = new FakeGoogleProvider({}, {}, { events: { 'cal1:initial': { items: [{ ...timed('r1'), recurrence: ['RRULE:FREQ=DAILY'] }], nextSyncToken: 't1' } }, instances: { 'cal1:r1:initial': { items: [{ ...timed('r1-jan10', '2026-01-10T11:00:00-05:00', '2026-01-10T12:00:00-05:00'), recurringEventId: 'r1', originalStartTime: { dateTime: '2026-01-10T09:00:00-05:00', timeZone: 'America/New_York' } }] } } }); const sync = new CalendarSync(db, keyFromSecret('secret'), provider, queue, repo, () => now); queue.enqueue({ kind: 'calendar_sync', scopeId: 'c1', dedupeKey: 'calendar:1', payload: { connectionId: 'c1', generation: 1, calendarSelectionId: 'sel1' } }); const result = await sync.run(queue.claim(['calendar_sync'])!); expect(result.state).toBe('complete'); expect(db.prepare("SELECT cursor FROM sync_states WHERE source_kind = 'calendar'").get()).toEqual({ cursor: 't1' }); expect(db.prepare('SELECT COUNT(*) AS count FROM calendar_occurrences').get()).toEqual({ count: 2 }); });
  it('keeps work and canceled occurrences out of the shared agenda', async () => { db.prepare('UPDATE calendar_selections SET classification = ?').run('work'); const provider = new FakeGoogleProvider({}, {}, { events: { 'cal1:initial': { items: [{ ...timed('cancelled'), status: 'cancelled', recurringEventId: 'r1', originalStartTime: { dateTime: '2026-01-10T09:00:00-05:00' } }], nextSyncToken: 't1' } } }); const sync = new CalendarSync(db, keyFromSecret('secret'), provider, queue, repo, () => now); queue.enqueue({ kind: 'calendar_sync', scopeId: 'c1', dedupeKey: 'calendar:work', payload: { connectionId: 'c1', generation: 1, calendarSelectionId: 'sel1' } }); await sync.run(queue.claim(['calendar_sync'])!); expect(repo.agenda({ memberId: 'm1', householdId: 'h1' })).toHaveLength(0); expect(db.prepare("SELECT visibility, status FROM calendar_occurrences").get()).toEqual({ visibility: 'owner', status: 'cancelled' }); });
  it('rebuilds an expired cursor without blanking the retained agenda or changing selection policy', async () => { db.prepare("INSERT INTO sync_states (id, connection_id, source_kind, stream_key, cursor, query_version, generation, created_at, updated_at) VALUES ('s1', 'c1', 'calendar', 'sel1', 'old', 'calendar-v1', 1, ?, ?)").run(now.toISOString(), now.toISOString()); db.prepare('UPDATE sync_states SET calendar_full_sync_at=?').run(now.toISOString()); repo.persist(repo.stream('sel1')!, timed('retained'), { kind: 'timed', start: '2026-01-10T09:00:00-05:00', end: '2026-01-10T10:00:00-05:00', timezone: 'America/New_York' }, 'shared_eligible'); class ExpiredProvider extends FakeGoogleProvider { override async listCalendarEvents(): Promise<never> { throw new Error('GOOGLE_CALENDAR_SYNC_EXPIRED'); } } const sync = new CalendarSync(db, keyFromSecret('secret'), new ExpiredProvider(), queue, repo, () => now); queue.enqueue({ kind: 'calendar_sync', scopeId: 'c1', dedupeKey: 'calendar:expired', payload: { connectionId: 'c1', generation: 1, calendarSelectionId: 'sel1' } }); const result = await sync.run(queue.claim(['calendar_sync'])!); expect(result.state).toBe('retry'); expect(db.prepare("SELECT cursor, error_code FROM sync_states WHERE source_kind = 'calendar'").get()).toEqual({ cursor: null, error_code: 'GOOGLE_CALENDAR_SYNC_EXPIRED' }); expect(repo.agenda({ memberId: 'm1', householdId: 'h1' })).toHaveLength(1); expect((db.prepare('SELECT classification FROM calendar_selections').get() as { classification: string }).classification).toBe('household'); });
  it('refreshes an expired grant before calendar reads', async () => {
    db.prepare('UPDATE google_connections SET encrypted_tokens = ?').run(JSON.stringify(encryptJson({ ...grant, expiresAt: '2020-01-01T00:00:00Z' }, keyFromSecret('secret'), 'google-connection:c1')));
    const provider = new FakeGoogleProvider({}, {}, { events: { 'cal1:initial': { items: [], nextSyncToken: 't1' } } }); const refresh = vi.spyOn(provider, 'refresh').mockResolvedValue({ ...grant, accessToken: 'renewed' }); const list = vi.spyOn(provider, 'listCalendarEvents');
    const sync = new CalendarSync(db, keyFromSecret('secret'), provider, queue, repo, () => now); queue.enqueue({ kind: 'calendar_sync', scopeId: 'c1', dedupeKey: 'calendar:refresh', payload: { connectionId: 'c1', generation: 1, calendarSelectionId: 'sel1' } });
    const result = await sync.run(queue.claim(['calendar_sync'])!); expect(result.state).toBe('complete'); expect(refresh).toHaveBeenCalledTimes(1); expect(list).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'renewed' }), 'cal1', expect.anything());
  });
  it('retries when another worker owns the refresh lease', async () => {
    db.prepare('UPDATE google_connections SET encrypted_tokens = ?').run(JSON.stringify(encryptJson({ ...grant, expiresAt: '2020-01-01T00:00:00Z' }, keyFromSecret('secret'), 'google-connection:c1'))); db.prepare('INSERT INTO google_refresh_leases VALUES (?, ?, ?)').run('c1', 'other', new Date(now.getTime() + 60000).toISOString());
    const provider = new FakeGoogleProvider(); const list = vi.spyOn(provider, 'listCalendarEvents'); const sync = new CalendarSync(db, keyFromSecret('secret'), provider, queue, repo, () => now); queue.enqueue({ kind: 'calendar_sync', scopeId: 'c1', dedupeKey: 'calendar:busy', payload: { connectionId: 'c1', generation: 1, calendarSelectionId: 'sel1' } });
    expect(await sync.run(queue.claim(['calendar_sync'])!)).toMatchObject({ state: 'retry', retryKind: 'continuation' }); expect(list).not.toHaveBeenCalled();
  });
  it('stops after revoked consent and invalidates the calendar generation', async () => {
    db.prepare('UPDATE google_connections SET encrypted_tokens = ?').run(JSON.stringify(encryptJson({ ...grant, expiresAt: '2020-01-01T00:00:00Z' }, keyFromSecret('secret'), 'google-connection:c1'))); const provider = new FakeGoogleProvider(); vi.spyOn(provider, 'refresh').mockRejectedValue(new Error('GOOGLE_REAUTH_REQUIRED')); const list = vi.spyOn(provider, 'listCalendarEvents'); const sync = new CalendarSync(db, keyFromSecret('secret'), provider, queue, repo, () => now); queue.enqueue({ kind: 'calendar_sync', scopeId: 'c1', dedupeKey: 'calendar:reauth', payload: { connectionId: 'c1', generation: 1, calendarSelectionId: 'sel1' } });
    expect(await sync.run(queue.claim(['calendar_sync'])!)).toEqual({ state: 'complete' }); expect(list).not.toHaveBeenCalled(); expect(db.prepare('SELECT status, generation FROM google_connections').get()).toEqual({ status: 'needs_reauth', generation: 2 });
  });
  it('does not persist a page after the member is disabled during a request', async () => {
    const provider = new FakeGoogleProvider({}, {}, { events: { 'cal1:initial': { items: [timed('private')], nextSyncToken: 't1' } } }); vi.spyOn(provider, 'listCalendarEvents').mockImplementation(async () => { db.prepare('UPDATE members SET active = 0').run(); return { items: [timed('private')], nextSyncToken: 't1' }; }); const sync = new CalendarSync(db, keyFromSecret('secret'), provider, queue, repo, () => now); queue.enqueue({ kind: 'calendar_sync', scopeId: 'c1', dedupeKey: 'calendar:disable', payload: { connectionId: 'c1', generation: 1, calendarSelectionId: 'sel1' } });
    expect(await sync.run(queue.claim(['calendar_sync'])!)).toEqual({ state: 'complete' }); expect(db.prepare('SELECT count(*) AS count FROM calendar_occurrences').get()).toEqual({ count: 0 });
  });
  it('revalidates unchanged events daily while using incremental updates between refreshes', async () => {
    const provider = new FakeGoogleProvider();
    const list = vi.spyOn(provider, 'listCalendarEvents').mockImplementation(async (_grant, _calendar, input) => ({ items: input.syncToken ? [] : [timed('unchanged')], nextSyncToken: 'cursor' }));
    const sync = new CalendarSync(db, keyFromSecret('secret'), provider, queue, repo, () => now);
    let sequence = 0;
    const tick = async () => { queue.enqueue({ kind: 'calendar_sync', scopeId: 'c1', dedupeKey: `daily:${sequence++}`, payload: { connectionId: 'c1', generation: 1, calendarSelectionId: 'sel1' } }); const job = queue.claim(['calendar_sync'])!; const result = await sync.run(job); queue.finish(job); return result; };
    await tick();
    now = new Date(now.getTime() + 3600000); await tick();
    expect(list.mock.calls[1]![2]).toEqual({ syncToken: 'cursor' });
    for (let day = 0; day < 8; day++) { now = new Date(now.getTime() + 86400000); expect(await tick()).toEqual({ state: 'complete' }); }
    expect(repo.agenda({ memberId: 'm1', householdId: 'h1' }).map(event => event.providerEventId)).toEqual(['unchanged']);
    expect(list.mock.calls.slice(2).every(call => !call[2].syncToken)).toBe(true);
    now = new Date(now.getTime() + 8 * 86400000);
    expect(repo.agenda({ memberId: 'm1', householdId: 'h1' })).toHaveLength(0);
  });
  it('keeps old entries through a failed full refresh and prunes missing entries only after the final page', async () => {
    const provider = new FakeGoogleProvider(); const list = vi.spyOn(provider, 'listCalendarEvents');
    list.mockResolvedValueOnce({ items: [timed('removed'), timed('kept')], nextSyncToken: 'old' })
      .mockRejectedValueOnce(new Error('TEMPORARY'))
      .mockResolvedValueOnce({ items: [timed('kept')], nextPageToken: 'page2' })
      .mockResolvedValueOnce({ items: [timed('new')], nextSyncToken: 'new' });
    const sync = new CalendarSync(db, keyFromSecret('secret'), provider, queue, repo, () => now);
    let sequence = 0;
    const tick = async () => { queue.enqueue({ kind: 'calendar_sync', scopeId: 'c1', dedupeKey: `pages:${sequence++}`, payload: { connectionId: 'c1', generation: 1, calendarSelectionId: 'sel1' } }); const job = queue.claim(['calendar_sync'])!; const result = await sync.run(job); queue.finish(job); return result; };
    await tick(); now = new Date(now.getTime() + 86400000);
    expect((await tick()).state).toBe('retry'); expect(repo.agenda({ memberId: 'm1', householdId: 'h1' })).toHaveLength(2);
    expect((await tick()).state).toBe('retry'); expect(repo.agenda({ memberId: 'm1', householdId: 'h1' })).toHaveLength(2);
    await tick(); expect(list.mock.calls[3]![2]).toEqual({ pageToken: 'page2' });
    expect(repo.agenda({ memberId: 'm1', householdId: 'h1' }).map(event => event.providerEventId).sort()).toEqual(['kept', 'new']);
    expect(repo.state(repo.stream('sel1')!)!.calendar_refresh_token).toBeNull();
  });
  it('advances recurring instance windows even without a provider change to the series', async () => {
    const provider = new FakeGoogleProvider();
    vi.spyOn(provider, 'listCalendarEvents').mockResolvedValue({ items: [{ ...timed('series'), recurrence: ['RRULE:FREQ=DAILY'] }], nextSyncToken: 'cursor' });
    const instances = vi.spyOn(provider, 'listCalendarInstances').mockResolvedValueOnce({ items: [{ ...timed('old-instance'), recurringEventId: 'series' }] }).mockResolvedValueOnce({ items: [{ ...timed('new-instance'), recurringEventId: 'series' }] });
    const sync = new CalendarSync(db, keyFromSecret('secret'), provider, queue, repo, () => now);
    for (const day of [0, 1]) { now = new Date(`2026-01-0${day + 1}T00:00:00Z`); queue.enqueue({ kind: 'calendar_sync', scopeId: 'c1', dedupeKey: `recurring:${day}`, payload: { connectionId: 'c1', generation: 1, calendarSelectionId: 'sel1' } }); const job = queue.claim(['calendar_sync'])!; await sync.run(job); queue.finish(job); }
    expect(Date.parse(instances.mock.calls[1]![3].timeMax) - Date.parse(instances.mock.calls[0]![3].timeMax)).toBe(86400000);
    expect(repo.agenda({ memberId: 'm1', householdId: 'h1' }).map(event => event.providerEventId).sort()).toEqual(['new-instance', 'series']);
  });

});
