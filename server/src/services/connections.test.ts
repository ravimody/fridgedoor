import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionData } from '../auth/session.js';
import { decryptJson, encryptJson, keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { FakeGoogleProvider, GOOGLE_SCOPES, type GoogleGrant } from '../providers/google.js';
import { ConnectionService } from './connections.js';
import { repairCalendarIdentities } from './calendar-identity-repair.js';
import { CalendarRepository } from '../repos/calendar.js';
import { CalendarActionService } from './calendar-actions.js';
import { PlanRepository } from '../repos/plans.js';
import { JobQueue } from '../jobs/queue.js';

const member = { id: 'm1', householdId: 'h1', accessSubject: 's1', allowedEmail: 'alex@example.test', displayName: 'Alex', timezone: 'America/New_York', active: true };
const session = { id: 'session-1', member, csrfToken: 'csrf' } as SessionData;
function grant(overrides: Partial<GoogleGrant> = {}): GoogleGrant { return { sub: 'google-alex', email: 'alex@example.test', scopes: [...GOOGLE_SCOPES], accessToken: 'access', refreshToken: 'refresh', expiresAt: new Date(Date.now() + 3600000).toISOString(), ...overrides }; }
describe('Google connection lifecycle', () => { let db: Database.Database; let service: ConnectionService; let fake: FakeGoogleProvider; beforeEach(() => { db = new Database(':memory:'); migrate(db); const now = new Date().toISOString(); db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now); db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at, allowed_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Alex', 'America/New_York', 1, now, member.allowedEmail); db.prepare('INSERT INTO browser_sessions (id, token_digest, member_id, csrf_ciphertext, csrf_iv, csrf_tag, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('session-1', 'digest', 'm1', 'cipher', 'iv', 'tag', new Date(Date.now() + 3600000).toISOString(), now); fake = new FakeGoogleProvider({ good: grant() }); service = new ConnectionService(db, keyFromSecret('connection-secret'), fake, 'https://planner.example.test'); });
  async function begin() { const started = await service.start(member, session, 'privacy-v1'); return { state: new URL(started.authorizationUrl).searchParams.get('state')!, }; }
  it('binds consent to the owner and rejects a different account', async () => { const started = await begin(); const wrong = new FakeGoogleProvider({ wrong: grant({ email: 'sam@example.test', sub: 'google-sam' }) }); service = new ConnectionService(db, keyFromSecret('connection-secret'), wrong, 'https://planner.example.test'); await expect(service.callback(member, session, started.state, 'wrong')).rejects.toThrow('GOOGLE_ACCOUNT_MISMATCH'); expect(service.status(member.id).connected).toBe(false); });
  it('rejects missing scopes and makes a callback one-use', async () => { const started = await begin(); const limited = new FakeGoogleProvider({ limited: grant({ scopes: ['openid', 'email'] }) }); service = new ConnectionService(db, keyFromSecret('connection-secret'), limited, 'https://planner.example.test'); await expect(service.callback(member, session, started.state, 'limited')).rejects.toThrow('GOOGLE_SCOPES_INSUFFICIENT'); await expect(service.callback(member, session, started.state, 'limited')).rejects.toThrow('OAUTH_ATTEMPT_INVALID'); });
  it('stores a valid connection without exposing tokens in status', async () => { const started = await begin(); await service.callback(member, session, started.state, 'good'); const status = service.status(member.id); expect(status).toMatchObject({ connected: true, email: 'alex@example.test', status: 'active' }); expect(status).not.toHaveProperty('accessToken'); expect(service.calendars(member.id)).toHaveLength(1); });
  it('round-trips source booleans and exposes the current owned destination selection', async () => {
    fake.listCalendars = async () => [
      { id: 'household-fixture', summary: 'Household', accessRole: 'owner' },
      { id: 'other-fixture', summary: 'Other', accessRole: 'reader' },
    ];
    const started = await begin();
    await service.callback(member, session, started.state, 'good');
    const choices = service.calendars(member.id).sort((a, b) => a.name.localeCompare(b.name));
    expect(choices.map((calendar) => calendar.selected)).toEqual([false, false]);
    expect(() => service.setDestination(member, choices[0]!.id, service.status(member.id).revision)).toThrow('DESTINATION_NOT_ALLOWED');
    await service.setCalendars(member, choices.map((calendar, index) => ({ id: calendar.id, selected: index === 0, classification: 'household' })));
    expect(service.calendars(member.id).sort((a, b) => a.name.localeCompare(b.name)).map((calendar) => calendar.selected)).toEqual([true, false]);
    const destination = service.setDestination(member, choices[0]!.id, service.status(member.id).revision);
    expect(destination).toMatchObject({ active: true, name: 'Household', ownCalendarSelectionId: choices[0]!.id });
    expect(service.destination(member.id)).toEqual(destination);
    const key = keyFromSecret('connection-secret');
    const actor = { memberId: member.id, householdId: member.householdId };
    const calendars = new CalendarRepository(db, key);
    expect(calendars.calendarId(calendars.streams()[0]!)).toBe('household-fixture');
    const plans = new PlanRepository(db, key);
    const id = plans.createPrivate(actor, { title: 'Synthetic picnic', category: 'household', participants: [], preparationTasks: [], unresolvedFields: [], time: { kind: 'timed', start: '2026-09-13T11:00:00-04:00', end: '2026-09-13T12:00:00-04:00', timezone: member.timezone } });
    const plan = plans.detail(id, member.id);
    const shared = plans.share(id, member.id, plan.revision, plan.facts);
    const queue = new JobQueue(db);
    const actions = new CalendarActionService(db, key, queue, fake);
    const action = actions.apply(actor, id, shared.revision, 'create', 'synthetic-action');
    // Destination envelopes may belong to the other member who chose the calendar.
    // The writer must use their own current calendar selection, not that envelope.
    db.prepare("UPDATE destination_bindings SET encrypted_calendar_id = '{}' WHERE active = 1").run();
    const job = queue.claim(['calendar_action']);
    expect(job).toBeTruthy();
    await actions.run(job!);
    expect(actions.status(actor, action.actionId).state).toBe('succeeded');
  });
  it('repairs legacy envelopes without resetting choices and is safe to rerun', async () => {
    const started = await begin();
    await service.callback(member, session, started.state, 'good');
    const choice = service.calendars(member.id)[0]!;
    await service.setCalendars(member, [{ id: choice.id, selected: true, classification: 'personal' }]);
    const key = keyFromSecret('connection-secret');
    const connection = db.prepare('SELECT id FROM google_connections WHERE member_id = ?').get(member.id) as { id: string };
    db.prepare('UPDATE calendar_selections SET encrypted_calendar_id = ? WHERE id = ?').run(JSON.stringify(encryptJson({ id: 'fake-shared-calendar' }, key, `calendar:${connection.id}:fake-shared-calendar`)), choice.id);
    const before = service.calendars(member.id);
    expect(await repairCalendarIdentities(db, key, fake)).toEqual({ repaired: 1 });
    expect(service.calendars(member.id)).toEqual(before);
    const calendars = new CalendarRepository(db, key);
    expect(calendars.calendarId(calendars.streams()[0]!)).toBe('fake-shared-calendar');
    expect(await repairCalendarIdentities(db, key, fake)).toEqual({ repaired: 0 });
  });
  it('exposes scoped calendar sync counts and sanitized errors', async () => {
    const started = await begin(); await service.callback(member, session, started.state, 'good');
    const selection = service.calendars(member.id)[0]!;
    await service.setCalendars(member, [{ id: selection.id, selected: true, classification: 'personal' }]);
    const calendars = new CalendarRepository(db, keyFromSecret('connection-secret'));
    const stream = calendars.streams()[0]!; calendars.ensureState(stream);
    calendars.persist(stream, { id: 'future', status: 'confirmed' }, { kind: 'timed', start: new Date().toISOString(), end: new Date(Date.now() + 3600000).toISOString(), timezone: member.timezone }, 'owner');
    calendars.complete(stream, 'cursor');
    expect(service.calendars(member.id)[0]!.sync).toMatchObject({ lastSuccessAt: expect.any(String), imported: 1, upcoming: 1, error: null, stale: false });
    calendars.error(stream, 'private provider message');
    expect(service.calendars(member.id)[0]!.sync.error).toBe('retrying');
    expect(JSON.stringify(service.calendars(member.id))).not.toContain('private provider message');
    expect(service.calendars('another-owner')).toEqual([]);
    db.prepare("UPDATE sync_states SET generation = 99").run();
    expect(service.calendars(member.id)[0]!.sync.lastSuccessAt).toBeNull();
  });
  it('accepts Google equivalent scope names from the authorization response', async () => { const started = await begin(); const alias = new FakeGoogleProvider({ alias: grant({ scopes: [...GOOGLE_SCOPES].map((scope) => scope === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : scope) }) }); service = new ConnectionService(db, keyFromSecret('connection-secret'), alias, 'https://planner.example.test'); await service.callback(member, session, started.state, 'alias'); expect(service.status(member.id).connected).toBe(true); });
  async function reconnect(overrides: Omit<Partial<GoogleGrant>, 'refreshToken'> & { refreshToken?: string | undefined }) {
    const started = await begin();
    const { refreshToken, ...rest } = overrides;
    const nextGrant = grant(rest);
    if ('refreshToken' in overrides) {
      if (refreshToken === undefined) delete nextGrant.refreshToken;
      else nextGrant.refreshToken = refreshToken;
    }
    const provider = new FakeGoogleProvider({ reconnect: nextGrant });
    service = new ConnectionService(db, keyFromSecret('connection-secret'), provider, 'https://planner.example.test');
    return service.callback(member, session, started.state, 'reconnect');
  }
  function savedGrant() {
    const row = db.prepare('SELECT id, encrypted_tokens FROM google_connections WHERE member_id = ?').get(member.id) as { id: string; encrypted_tokens: string };
    return decryptJson<GoogleGrant>(JSON.parse(row.encrypted_tokens), keyFromSecret('connection-secret'), `google-connection:${row.id}`);
  }
  it('requires offline access before creating the first connection', async () => {
    await expect(reconnect({ refreshToken: undefined })).rejects.toThrow('GOOGLE_OFFLINE_ACCESS_REQUIRED');
    expect(service.status(member.id).connected).toBe(false);
    expect(db.prepare('SELECT count(*) AS count FROM google_connections').get()).toEqual({ count: 0 });
  });
  it('preserves a refresh token on same-account reconnect when Google omits it', async () => {
    await reconnect({});
    await reconnect({ refreshToken: undefined, accessToken: 'new-access' });
    expect(savedGrant()).toMatchObject({ refreshToken: 'refresh', accessToken: 'new-access' });
  });
  it('pins the Google subject even when another account has the same allowed email', async () => {
    await reconnect({});
    const before = savedGrant();
    await expect(reconnect({ sub: 'different-google-subject' })).rejects.toThrow('GOOGLE_ACCOUNT_MISMATCH');
    expect(savedGrant()).toEqual(before);
  });
  it('does not reuse a disconnected grant when a new consent omits offline access', async () => {
    await reconnect({});
    await service.transition(member.id, 'disconnect', service.status(member.id).revision);
    await expect(reconnect({ refreshToken: undefined })).rejects.toThrow('GOOGLE_OFFLINE_ACCESS_REQUIRED');
    expect(service.status(member.id).status).toBe('disconnected');
  });
  it('can reconnect after private token deletion using a fresh same-account grant', async () => {
    await reconnect({});
    service.deletePrivateData(member.id);
    await reconnect({ refreshToken: 'fresh-refresh' });
    expect(savedGrant().refreshToken).toBe('fresh-refresh');
  });
});
