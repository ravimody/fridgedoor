import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { SettingsStore } from '../settings.js';
import { AccountService, loadActiveMembers } from '../auth/accounts.js';
import { Hono } from 'hono';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Variables } from '../app.js';
import { hashPassword, needsRehash, SCRYPT_N, verifyPassword } from '../auth/passwords.js';
import { SessionStore, sessionCookie } from '../auth/session.js';
import { addressKey, clientAddress } from './accounts.js';

const SECRET = 'test-session-secret-change-me-1234567890';
function setup(env: Record<string, string> = {}) {
  const db = new Database(':memory:'); migrate(db);
  const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: SECRET, ...env });
  const settings = new SettingsStore(db, SECRET);
  settings.set('setup_token', 'setup-token-abcdefghijkl');
  return { db, config, settings, app: createApp({ db, config }) };
}
const owner = { householdName: 'The Riveras', displayName: 'Alex', email: 'Alex@Example.test', password: 'correct horse battery', timezone: 'America/New_York' };
const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const cookieOf = (response: Response) => response.headers.get('set-cookie')!.split(';')[0]!;

async function createOwner(ctx: ReturnType<typeof setup>) {
  const response = await ctx.app.request('http://fridgedoor.local:8080/dashboard/api/v1/auth/setup', json({ token: 'setup-token-abcdefghijkl', ...owner }, { Origin: 'http://fridgedoor.local:8080', Host: 'fridgedoor.local:8080' }));
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { csrfToken: string } };
  return { cookie: cookieOf(response), csrf: body.data.csrfToken };
}

describe('first-run setup', () => {
  it('creates the household once, learns the public address and signs the owner in', async () => {
    const ctx = setup();
    expect(await (await ctx.app.request('/dashboard/api/v1/auth/status')).json()).toMatchObject({ data: { setupRequired: true, accessMode: false } });
    const wrong = await ctx.app.request('http://fridgedoor.local:8080/dashboard/api/v1/auth/setup', json({ token: 'nope-nope-nope-nope', ...owner }, { Origin: 'http://fridgedoor.local:8080', Host: 'fridgedoor.local:8080' }));
    expect(wrong.status).toBe(403);
    const spoofed = await ctx.app.request('http://fridgedoor.local:8080/dashboard/api/v1/auth/setup', json({ token: 'setup-token-abcdefghijkl', ...owner }, { Origin: 'https://evil.example', Host: 'fridgedoor.local:8080' }));
    expect(spoofed.status).toBe(403);
    const { cookie } = await createOwner(ctx);
    // Plain HTTP can't carry a __Host- cookie.
    expect(cookie.startsWith('fridgedoor-session=')).toBe(true);
    expect(ctx.config.APP_ORIGIN).toBe('http://fridgedoor.local:8080');
    expect(ctx.settings.get('public_url')).toBe('http://fridgedoor.local:8080');
    expect(ctx.settings.get('setup_token')).toBeUndefined();
    const me = await ctx.app.request('/dashboard/api/v1/me', { headers: { Cookie: cookie } });
    expect(await me.json()).toMatchObject({ data: { member: { displayName: 'Alex' }, householdName: 'The Riveras', email: 'alex@example.test', role: 'owner', canManage: true } });
    const again = await ctx.app.request('http://fridgedoor.local:8080/dashboard/api/v1/auth/setup', json({ token: 'setup-token-abcdefghijkl', ...owner }, { Origin: 'http://fridgedoor.local:8080', Host: 'fridgedoor.local:8080' }));
    expect(again.status).toBe(409);
  });

  it('requires the configured address when PUBLIC_URL is set and uses secure cookies over HTTPS', async () => {
    const ctx = setup({ PUBLIC_URL: 'https://fridgedoor.example.test' });
    const response = await ctx.app.request('https://fridgedoor.example.test/dashboard/api/v1/auth/setup', json({ token: 'setup-token-abcdefghijkl', ...owner }, { Origin: 'https://fridgedoor.example.test', Host: 'fridgedoor.example.test' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/^__Host-fridgedoor-session=.*Secure/);
  });
});

describe('sign-in, invites and pairing', () => {
  it('signs in with email and password and limits guessing', async () => {
    const ctx = setup(); await createOwner(ctx);
    const origin = { Origin: 'http://fridgedoor.local:8080' };
    expect((await ctx.app.request('/dashboard/api/v1/auth/login', json({ email: 'alex@example.test', password: 'wrong password' }, origin))).status).toBe(401);
    expect((await ctx.app.request('/dashboard/api/v1/auth/login', json({ email: 'alex@example.test', password: owner.password }, { Origin: 'https://evil.example' }))).status).toBe(403);
    const ok = await ctx.app.request('/dashboard/api/v1/auth/login', json({ email: 'ALEX@example.test', password: owner.password }, origin));
    expect(ok.status).toBe(200);
    const session = await ctx.app.request('/dashboard/api/v1/session', { method: 'POST', headers: { Cookie: cookieOf(ok), Origin: 'http://fridgedoor.local:8080', 'X-Planner-Bootstrap': '1' } });
    expect(session.status).toBe(200);
    let last = 0;
    for (let attempt = 0; attempt < 11; attempt++) last = (await ctx.app.request('/dashboard/api/v1/auth/login', json({ email: 'alex@example.test', password: 'guess' + attempt }, origin))).status;
    expect(last).toBe(429);
  });

  it('lets the owner invite a partner, who joins as a member', async () => {
    const ctx = setup(); const { cookie, csrf } = await createOwner(ctx);
    const auth = { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'http://fridgedoor.local:8080' };
    const invite = await ctx.app.request('/dashboard/api/v1/household/invites', { method: 'POST', headers: auth });
    expect(invite.status).toBe(201);
    const { data } = await invite.json() as { data: { url: string } };
    expect(data.url).toMatch(/^http:\/\/fridgedoor\.local:8080\/dashboard\/join\//);
    const token = data.url.split('/').pop()!;
    expect(await (await ctx.app.request(`/dashboard/api/v1/auth/invites/${token}`)).json()).toEqual({ data: { householdName: 'The Riveras', invitedBy: 'Alex' } });
    const joined = await ctx.app.request(`/dashboard/api/v1/auth/invites/${token}`, json({ displayName: 'Sam', email: 'sam@example.test', password: 'another long one', timezone: 'America/Chicago' }, { Origin: 'http://fridgedoor.local:8080' }));
    expect(joined.status).toBe(200);
    expect((await ctx.app.request(`/dashboard/api/v1/auth/invites/${token}`)).status).toBe(404);
    const samCookie = cookieOf(joined); const samCsrf = (await joined.json() as { data: { csrfToken: string } }).data.csrfToken;
    const samInvite = await ctx.app.request('/dashboard/api/v1/household/invites', { method: 'POST', headers: { Cookie: samCookie, 'X-CSRF-Token': samCsrf, Origin: 'http://fridgedoor.local:8080' } });
    expect(samInvite.status).toBe(403);
    const household = await (await ctx.app.request('/dashboard/api/v1/household', { headers: { Cookie: cookie } })).json() as { data: { members: Array<{ displayName: string; role: string; email?: string }> } };
    expect(household.data.members.map((member) => [member.displayName, member.role, member.email])).toEqual([['Alex', 'owner', 'alex@example.test'], ['Sam', 'member', 'sam@example.test']]);
  });

  it('behind Cloudflare Access, links the joiner to their Access identity', async () => {
    const db = new Database(':memory:'); migrate(db);
    const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: SECRET, APP_ORIGIN: 'https://fridgedoor.example.test' });
    const now = new Date().toISOString(); const origin = { Origin: 'https://fridgedoor.example.test' };
    db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now);
    db.prepare("INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, role, created_at) VALUES (?, ?, ?, ?, ?, 1, 'owner', ?)").run('m1', 'h1', 'subject-alex', 'Alex', 'America/New_York', now);
    const app = createApp({ db, config, verifyAccess: async (token) => ({ alex: { subject: 'subject-alex' }, sam: { subject: 'subject-sam' } })[token] ?? null });
    const bootstrap = (who: string) => app.request('/dashboard/api/v1/session', { method: 'POST', headers: { Authorization: `Bearer ${who}`, ...origin, 'X-Planner-Bootstrap': '1' } });
    const alex = await bootstrap('alex'); const csrf = (await alex.json() as { data: { csrfToken: string } }).data.csrfToken;
    const invite = await app.request('/dashboard/api/v1/household/invites', { method: 'POST', headers: { Authorization: 'Bearer alex', Cookie: cookieOf(alex), 'X-CSRF-Token': csrf, ...origin } });
    const token = (await invite.json() as { data: { url: string } }).data.url.split('/').pop()!;
    const profile = { displayName: 'Sam', email: 'sam@example.test', password: 'another long one', timezone: 'America/Chicago' };
    expect((await bootstrap('sam')).status).toBe(403);
    expect((await app.request(`/dashboard/api/v1/auth/invites/${token}`, json(profile, origin))).status).toBe(401);
    expect((await app.request(`/dashboard/api/v1/auth/invites/${token}`, json(profile, { ...origin, Authorization: 'Bearer sam' }))).status).toBe(200);
    expect((await bootstrap('sam')).status).toBe(200);
    const again = await app.request('/dashboard/api/v1/household/invites', { method: 'POST', headers: { Authorization: 'Bearer alex', Cookie: cookieOf(alex), 'X-CSRF-Token': csrf, ...origin } });
    const second = (await again.json() as { data: { url: string } }).data.url.split('/').pop()!;
    const repeat = await app.request(`/dashboard/api/v1/auth/invites/${second}`, json({ ...profile, email: 'sam2@example.test' }, { ...origin, Authorization: 'Bearer sam' }));
    expect(repeat.status).toBe(409); expect((await repeat.json() as { error: { code: string } }).error.code).toBe('ALREADY_MEMBER');
    db.prepare("UPDATE members SET active = 0 WHERE access_subject = 'subject-sam'").run();
    const removed = await app.request(`/dashboard/api/v1/auth/invites/${second}`, json({ ...profile, email: 'sam2@example.test' }, { ...origin, Authorization: 'Bearer sam' }));
    expect((await removed.json() as { error: { code: string } }).error.code).toBe('MEMBER_REMOVED');
  });

  it('removing a member ends their sessions', async () => {
    const ctx = setup(); const { cookie, csrf } = await createOwner(ctx);
    const auth = { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'http://fridgedoor.local:8080', 'Content-Type': 'application/json' };
    const token = ((await (await ctx.app.request('/dashboard/api/v1/household/invites', { method: 'POST', headers: auth })).json()) as { data: { url: string } }).data.url.split('/').pop()!;
    const joined = await ctx.app.request(`/dashboard/api/v1/auth/invites/${token}`, json({ displayName: 'Sam', email: 'sam@example.test', password: 'another long one', timezone: 'America/Chicago' }, { Origin: 'http://fridgedoor.local:8080' }));
    const samId = (await joined.json() as { data: { member: { id: string } } }).data.member.id;
    expect((await ctx.app.request(`/dashboard/api/v1/household/members/${samId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ active: false }) })).status).toBe(200);
    expect((await ctx.app.request('/dashboard/api/v1/me', { headers: { Cookie: cookieOf(joined) } })).status).toBe(401);
  });

  it('pairs a phone with a one-time QR code', async () => {
    const ctx = setup(); const { cookie, csrf } = await createOwner(ctx);
    const pairing = await ctx.app.request('/dashboard/api/v1/devices/pairing', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'http://fridgedoor.local:8080' } });
    expect(pairing.status).toBe(201);
    const { data } = await pairing.json() as { data: { link: string; qrSvg: string } };
    expect(data.qrSvg).toContain('<svg');
    const link = new URL(data.link);
    expect(link.protocol).toBe('fridgedoor:');
    expect(link.searchParams.get('server')).toBe('http://fridgedoor.local:8080');
    const exchange = () => ctx.app.request('/native/v1/auth/token', json({ grantType: 'pairing_code', code: link.searchParams.get('code'), deviceLabel: 'Alex’s iPhone' }));
    const first = await exchange();
    expect(first.status).toBe(200);
    const tokens = await first.json() as { data: { accessToken: string; member: { displayName: string } } };
    expect(tokens.data.member.displayName).toBe('Alex');
    expect((await ctx.app.request('/native/v1/me', { headers: { Authorization: `Bearer ${tokens.data.accessToken}` } })).status).toBe(200);
    const reused = await exchange();
    expect(reused.status).toBe(401);
    expect(await reused.json()).toMatchObject({ error: { code: 'PAIRING_CODE_USED' } });
  });

  it('a password change signs out phones and other browsers but keeps this one', async () => {
    const ctx = setup(); const { cookie, csrf } = await createOwner(ctx);
    const auth = { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'http://fridgedoor.local:8080' };
    const other = await ctx.app.request('/dashboard/api/v1/auth/login', json({ email: 'alex@example.test', password: owner.password }, { Origin: 'http://fridgedoor.local:8080' }));
    const code = new URL(((await (await ctx.app.request('/dashboard/api/v1/devices/pairing', { method: 'POST', headers: auth })).json()) as { data: { link: string } }).data.link).searchParams.get('code');
    const phone = ((await (await ctx.app.request('/native/v1/auth/token', json({ grantType: 'pairing_code', code }))).json()) as { data: { accessToken: string } }).data.accessToken;
    const changed = await ctx.app.request('/dashboard/api/v1/account/password', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: owner.password, newPassword: 'a brand new password' }) });
    expect(changed.status).toBe(200);
    expect((await ctx.app.request('/dashboard/api/v1/me', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await ctx.app.request('/dashboard/api/v1/me', { headers: { Cookie: cookieOf(other) } })).status).toBe(401);
    expect((await ctx.app.request('/native/v1/me', { headers: { Authorization: `Bearer ${phone}` } })).status).toBe(401);
  });

  it('gives a member created for an identity proxy a password sign-in', async () => {
    const db = new Database(':memory:'); migrate(db); const now = new Date().toISOString();
    db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now);
    db.prepare("INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES ('m1', 'h1', 'access-sub-1', 'Alex', 'UTC', 1, ?)").run(now);
    const accounts = new AccountService(db);
    await accounts.addLogin('m1', 'Alex@Example.test', 'a long new password', 'owner');
    expect((await accounts.login('alex@example.test', 'a long new password'))?.accessSubject).toBe('access-sub-1');
    await expect(accounts.addLogin('m1', 'other@example.test', 'a long new password', 'owner')).rejects.toThrow('LOGIN_EXISTS');
    expect(accounts.listMembers()).toMatchObject([{ id: 'm1', email: 'alex@example.test', role: 'owner' }]);
  });
});

describe('household ownership', () => {
  it('behind Cloudflare Access, the creator is bound to their Access identity and owns the household; an invitee cannot manage', async () => {
    const db = new Database(':memory:'); migrate(db);
    const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: SECRET, PUBLIC_URL: 'https://fridgedoor.example.test' });
    new SettingsStore(db, SECRET).set('setup_token', 'setup-token-abcdefghijkl');
    const origin = { Origin: 'https://fridgedoor.example.test' };
    const app = createApp({ db, config, verifyAccess: async (token) => ({ alex: { subject: 'subject-alex' }, sam: { subject: 'subject-sam' } })[token] ?? null });
    const body = { token: 'setup-token-abcdefghijkl', ...owner };
    expect((await app.request('/dashboard/api/v1/auth/setup', json(body, origin))).status).toBe(401);
    expect((await app.request('/dashboard/api/v1/auth/setup', json(body, { ...origin, Authorization: 'Bearer alex' }))).status).toBe(200);
    const bootstrap = (who: string) => app.request('/dashboard/api/v1/session', { method: 'POST', headers: { Authorization: `Bearer ${who}`, ...origin, 'X-Fridgedoor-Bootstrap': '1' } });
    const alex = await bootstrap('alex'); expect(alex.status).toBe(200);
    const alexAuth = { Authorization: 'Bearer alex', Cookie: cookieOf(alex), 'X-CSRF-Token': (await alex.json() as { data: { csrfToken: string } }).data.csrfToken, ...origin };
    expect(await (await app.request('/dashboard/api/v1/me', { headers: alexAuth })).json()).toMatchObject({ data: { role: 'owner', canManage: true } });
    const token = ((await (await app.request('/dashboard/api/v1/household/invites', { method: 'POST', headers: alexAuth })).json()) as { data: { url: string } }).data.url.split('/').pop()!;
    expect((await app.request(`/dashboard/api/v1/auth/invites/${token}`, json({ displayName: 'Sam', email: 'sam@example.test', password: 'another long one', timezone: 'America/Chicago' }, { ...origin, Authorization: 'Bearer sam' }))).status).toBe(200);
    const sam = await bootstrap('sam');
    const samAuth = { Authorization: 'Bearer sam', Cookie: cookieOf(sam), 'X-CSRF-Token': (await sam.json() as { data: { csrfToken: string } }).data.csrfToken, ...origin };
    expect(await (await app.request('/dashboard/api/v1/me', { headers: samAuth })).json()).toMatchObject({ data: { role: 'member', canManage: false } });
    expect((await app.request('/dashboard/api/v1/household/invites', { method: 'POST', headers: samAuth })).status).toBe(403);
    expect((await app.request('/dashboard/api/v1/admin/ai', { headers: samAuth })).status).toBe(403);
    expect((await app.request('/dashboard/api/v1/admin/server', { headers: alexAuth })).status).toBe(200);
  });

  it('migrates roles: keeps owner logins and promotes the earliest active member where nobody owns the household', () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    const dir = fileURLToPath(new URL('../db/migrations', import.meta.url));
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const name of readdirSync(dir).filter((entry) => entry < '0040').sort()) { db.exec(readFileSync(join(dir, name), 'utf8')); db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(name, 'then'); }
    const member = (id: string, household: string, created: string, active = 1) => db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, household, `s-${id}`, id, 'UTC', active, created);
    for (const household of ['with-owner', 'access-only']) db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run(household, '2026-01-01');
    member('first', 'with-owner', '2026-01-01'); member('owner', 'with-owner', '2026-01-02');
    db.prepare("INSERT INTO member_logins (member_id, email, password_hash, role, created_at, updated_at) VALUES ('owner', 'o@example.test', 'x', 'owner', 'then', 'then')").run();
    member('removed', 'access-only', '2025-12-01', 0); member('earliest', 'access-only', '2026-01-01'); member('later', 'access-only', '2026-01-05');
    migrate(db);
    expect(db.prepare('SELECT id, role FROM members ORDER BY id').all()).toEqual([{ id: 'earliest', role: 'owner' }, { id: 'first', role: 'member' }, { id: 'later', role: 'member' }, { id: 'owner', role: 'owner' }, { id: 'removed', role: 'member' }]);
  });

  it('add-login as owner promotes, and as member never demotes the last owner', async () => {
    const db = new Database(':memory:'); migrate(db); const now = new Date().toISOString();
    db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now);
    db.prepare("INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, role, created_at) VALUES ('m1', 'h1', 'a1', 'Alex', 'UTC', 1, 'owner', ?), ('m2', 'h1', 'a2', 'Sam', 'UTC', 1, 'member', ?)").run(now, now);
    const accounts = new AccountService(db);
    await accounts.addLogin('m1', 'alex@example.test', 'a long new password', 'member');
    await accounts.addLogin('m2', 'sam@example.test', 'a long new password', 'owner');
    expect(accounts.listMembers().map((row) => [row.id, row.role])).toEqual([['m1', 'owner'], ['m2', 'owner']]);
    expect(db.prepare('SELECT member_id, role FROM member_logins ORDER BY member_id').all()).toEqual([{ member_id: 'm1', role: 'owner' }, { member_id: 'm2', role: 'owner' }]);
  });
});

describe('sign-in limits', () => {
  it('a stranger guessing from many addresses cannot lock out the right password', async () => {
    const db = new Database(':memory:'); migrate(db);
    const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: SECRET, PUBLIC_URL: 'https://fridgedoor.example.test', TRUST_PROXY: 'true' });
    new SettingsStore(db, SECRET).set('setup_token', 'setup-token-abcdefghijkl');
    const app = createApp({ db, config });
    const origin = { Origin: 'https://fridgedoor.example.test' };
    expect((await app.request('/dashboard/api/v1/auth/setup', json({ token: 'setup-token-abcdefghijkl', ...owner }, origin))).status).toBe(200);
    const login = (password: string, ip: string) => app.request('/dashboard/api/v1/auth/login', json({ email: 'alex@example.test', password }, { ...origin, 'X-Forwarded-For': ip }));
    for (let i = 0; i < 50; i++) await login(`guess-${i}`, `198.51.100.${i}`);
    expect((await login('one more guess', '203.0.113.9')).status).toBe(429);
    expect((await login(owner.password, '203.0.113.10')).status).toBe(200);
  }, 60_000);

  it('limits one IPv6 /64 as one address', async () => {
    const ctx = setup({ TRUST_PROXY: 'true' }); await createOwner(ctx);
    const origin = { Origin: 'http://fridgedoor.local:8080' };
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await ctx.app.request('/dashboard/api/v1/auth/login', json({ email: 'alex@example.test', password: `guess-${i}` }, { ...origin, 'X-Forwarded-For': `2001:db8:1:2::${(i + 1).toString(16)}` }))).status;
    expect(last).toBe(429);
    expect((await ctx.app.request('/dashboard/api/v1/auth/login', json({ email: 'alex@example.test', password: 'guess' }, { ...origin, 'X-Forwarded-For': '2001:db8:1:3::1' }))).status).toBe(401);
  });

  it('keys addresses for rate limits', () => {
    expect(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0db8:0001:0002::1')).toBe('2001:db8:1:2::/64');
    expect(addressKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(addressKey('192.0.2.1')).toBe('192.0.2.1');
  });

  it('reads the visitor address from the configured header or the last X-Forwarded-For hop', async () => {
    const app = new Hono<{ Variables: Variables }>();
    let config: Parameters<typeof clientAddress>[1] = {};
    app.get('/', (c) => c.text(clientAddress(c as never, config)));
    const ask = async (headers: Record<string, string>) => (await app.request('/', { headers })).text();
    config = { TRUST_PROXY: 'true' };
    expect(await ask({ 'X-Forwarded-For': '203.0.113.7, 198.51.100.2' })).toBe('198.51.100.2');
    expect(await ask({ 'X-Forwarded-For': 'not-an-ip' })).toBe('unknown');
    config = { TRUST_PROXY: 'true', CLIENT_IP_HEADER: 'Fly-Client-IP' };
    expect(await ask({ 'Fly-Client-IP': '203.0.113.8', 'X-Forwarded-For': '1.1.1.1, 66.241.124.1' })).toBe('203.0.113.8');
    config = {};
    expect(await ask({ 'Fly-Client-IP': '203.0.113.8', 'X-Forwarded-For': '203.0.113.7' })).toBe('unknown');
  });

  it('upgrades an older, cheaper password hash at sign-in', async () => {
    const ctx = setup(); await createOwner(ctx);
    ctx.db.prepare('UPDATE member_logins SET password_hash = ?').run(await hashPassword(owner.password, 2 ** 12));
    expect(needsRehash((ctx.db.prepare('SELECT password_hash FROM member_logins').get() as { password_hash: string }).password_hash)).toBe(true);
    expect(await new AccountService(ctx.db).login(owner.email, owner.password)).not.toBeNull();
    const upgraded = (ctx.db.prepare('SELECT password_hash FROM member_logins').get() as { password_hash: string }).password_hash;
    expect(upgraded.split('$')[1]).toBe(String(SCRYPT_N));
    expect(await verifyPassword(owner.password, upgraded)).toBe(true);
  });
});

describe('signing a phone out', () => {
  const pair = async (ctx: ReturnType<typeof setup>, auth: Record<string, string>) => {
    const code = new URL(((await (await ctx.app.request('/dashboard/api/v1/devices/pairing', { method: 'POST', headers: auth })).json()) as { data: { link: string } }).data.link).searchParams.get('code');
    const phone = ((await (await ctx.app.request('/native/v1/auth/token', json({ grantType: 'pairing_code', code }))).json()) as { data: { accessToken: string } }).data.accessToken;
    const credential = ((await (await ctx.app.request('/native/v1/capture-credentials', json({ label: 'Share sheet' }, { Authorization: `Bearer ${phone}` }))).json()) as { data: { token: string } }).data.token;
    return { phone, credential };
  };
  const captureId = (ctx: ReturnType<typeof setup>, credential: string) => ctx.app.request('/capture/v1/request-id', { method: 'POST', headers: { Authorization: `Bearer ${credential}` } });

  it('revokes the Share credentials that phone made', async () => {
    const ctx = setup(); const { cookie, csrf } = await createOwner(ctx);
    const auth = { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'http://fridgedoor.local:8080' };
    const first = await pair(ctx, auth); const second = await pair(ctx, auth);
    expect((await captureId(ctx, first.credential)).status).toBe(200);
    expect((await ctx.app.request('/native/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${first.phone}` } })).status).toBe(204);
    expect((await captureId(ctx, first.credential)).status).toBe(401);
    expect((await captureId(ctx, second.credential)).status).toBe(200);
  });

  it('a password change revokes other phones, their Share credentials and push subscriptions', async () => {
    const ctx = setup(); const { cookie, csrf } = await createOwner(ctx);
    const auth = { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'http://fridgedoor.local:8080' };
    const phone = await pair(ctx, auth);
    const memberId = (ctx.db.prepare('SELECT id FROM members').get() as { id: string }).id;
    ctx.db.prepare("INSERT INTO push_subscriptions (id, member_id, endpoint_hash, encrypted_endpoint, encrypted_keys, label, session_id, status, created_at, updated_at) VALUES ('p-other', ?, 'h1', 'e', 'k', 'Other browser', 'another-session', 'enabled', 'now', 'now')").run(memberId);
    const changed = await ctx.app.request('/dashboard/api/v1/account/password', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: owner.password, newPassword: 'a brand new password' }) });
    expect(changed.status).toBe(200);
    expect((await captureId(ctx, phone.credential)).status).toBe(401);
    expect(ctx.db.prepare('SELECT count(*) AS count FROM push_subscriptions').get()).toEqual({ count: 0 });
  });
});

describe('browser session plumbing', () => {
  it('accepts the bootstrap header under its old name too, and only skips the session check for the exact bootstrap path', async () => {
    const ctx = setup(); const { cookie } = await createOwner(ctx);
    const origin = { Origin: 'http://fridgedoor.local:8080' };
    for (const header of ['X-Fridgedoor-Bootstrap', 'X-Planner-Bootstrap']) expect((await ctx.app.request('/dashboard/api/v1/session', { method: 'POST', headers: { Cookie: cookie, ...origin, [header]: '1' } })).status).toBe(200);
    expect((await ctx.app.request('/dashboard/api/v1/session', { method: 'POST', headers: { Cookie: cookie, ...origin } })).status).toBe(403);
    // A path that merely ends in /session still needs CSRF.
    expect((await ctx.app.request('/dashboard/api/v1/plans/x/session', { method: 'POST', headers: { Cookie: cookie, ...origin } })).status).toBe(403);
  });

  it('keeps sessions created with the old session key working', async () => {
    const ctx = setup(); const { cookie, csrf } = await createOwner(ctx);
    const member = loadActiveMembers(ctx.db)[0]!;
    const legacy = new SessionStore(ctx.db, Buffer.from(SECRET).subarray(0, 32)).create(member);
    const response = await ctx.app.request('/dashboard/api/v1/household', { method: 'PATCH', headers: { Cookie: sessionCookie(legacy.token, 60, false).split(';')[0]!, 'X-CSRF-Token': legacy.data.csrfToken, Origin: 'http://fridgedoor.local:8080', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }) });
    expect(response.status).toBe(200);
    void cookie; void csrf;
  });

  it('refuses browser-only endpoints from the phone however the path is spelled', async () => {
    const ctx = setup(); const { cookie, csrf } = await createOwner(ctx);
    const code = new URL(((await (await ctx.app.request('/dashboard/api/v1/devices/pairing', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'http://fridgedoor.local:8080' } })).json()) as { data: { link: string } }).data.link).searchParams.get('code');
    const phone = ((await (await ctx.app.request('/native/v1/auth/token', json({ grantType: 'pairing_code', code }))).json()) as { data: { accessToken: string } }).data.accessToken;
    const encoded = await ctx.app.request('/native/v1/%73ession', { method: 'POST', headers: { Authorization: `Bearer ${phone}` } });
    expect(encoded.status).toBe(404);
    expect(await encoded.json()).toMatchObject({ error: { code: 'NATIVE_UNSUPPORTED' } });
  });
});
