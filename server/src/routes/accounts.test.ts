import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { SettingsStore } from '../settings.js';
import { AccountService } from '../auth/accounts.js';

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
    db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run('m1', 'h1', 'subject-alex', 'Alex', 'America/New_York', now);
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
    expect((await app.request(`/dashboard/api/v1/auth/invites/${second}`, json({ ...profile, email: 'sam2@example.test' }, { ...origin, Authorization: 'Bearer sam' }))).status).toBe(409);
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
