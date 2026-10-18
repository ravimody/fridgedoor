import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { PlanFacts } from '@fridgedoor/contracts';
import { createApp } from '../app.js';
import { keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { PlanRepository } from '../repos/plans.js';

const config = { NODE_ENV: 'test' as const, DATABASE_PATH: ':memory:', SESSION_SECRET: 'test-session-secret-change-me-1234567890', APP_ORIGIN: 'https://planner.example.test' };
const facts: PlanFacts = { title: 'Private dentist visit', category: 'health', participants: ['Alex'], preparationTasks: [], unresolvedFields: [] };

function setup(clock?: () => Date) {
  const db = new Database(':memory:'); migrate(db); const now = new Date().toISOString();
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now);
  const members = [{ id: 'm1', householdId: 'h1', accessSubject: 'subject-alex', displayName: 'Alex', timezone: 'America/New_York', active: true }, { id: 'm2', householdId: 'h1', accessSubject: 'subject-sam', displayName: 'Sam', timezone: 'America/New_York', active: true }];
  for (const member of members) db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(member.id, 'h1', member.accessSubject, member.displayName, member.timezone, 1, now);
  const app = createApp({ db, config, ...(clock ? { now: clock } : {}), members: () => members.filter((member) => member.active), verifyAccess: async (token) => token === 'alex' ? { subject: 'subject-alex' } : token === 'sam' ? { subject: 'subject-sam' } : null });
  return { db, app, members };
}
const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
const state = 'state-0123456789abcdef';
const query = (challenge: string) => new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256', state, redirect_uri: 'fridgedoor://auth/callback' });
async function authorize(app: ReturnType<typeof setup>['app'], who: string, challenge: string) {
  const response = await app.request('/dashboard/native/authorize', { method: 'POST', headers: { Authorization: `Bearer ${who}`, Origin: config.APP_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: query(challenge).toString() });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location')!);
  expect(`${location.protocol}//${location.host}${location.pathname}`).toBe('fridgedoor://auth/callback');
  expect(location.searchParams.get('state')).toBe(state);
  return location.searchParams.get('code')!;
}
const exchange = (app: ReturnType<typeof setup>['app'], body: Record<string, unknown>) => app.request('/native/v1/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function signIn(app: ReturnType<typeof setup>['app'], who = 'alex') {
  const { verifier, challenge } = pkce(); const code = await authorize(app, who, challenge);
  const response = await exchange(app, { grantType: 'authorization_code', code, codeVerifier: verifier, deviceLabel: 'Test iPhone' });
  expect(response.status).toBe(200);
  return (await response.json()).data as { accessToken: string; refreshToken: string; member: { id: string } };
}
const bearer = (token: string, extra: Record<string, string> = {}) => ({ headers: { Authorization: `Bearer ${token}`, ...extra } });

describe('native sign-in handoff', () => {
  it('requires a signed-in browser, an exact redirect and same-origin confirmation', async () => {
    const { app } = setup(); const { challenge } = pkce();
    const signedOut = await app.request(`/dashboard/native/authorize?${query(challenge)}`);
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get('location')).toBe(`/dashboard/login?next=${encodeURIComponent(`/dashboard/native/authorize?${query(challenge)}`)}`);
    const page = await app.request(`/dashboard/native/authorize?${query(challenge)}`, bearer('alex'));
    expect(page.status).toBe(200); expect(await page.text()).toContain('Continue as Alex');
    // CSP form-action also governs the post-submit redirect to the app's callback scheme.
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self' fridgedoor:");
    const wrongRedirect = query(challenge); wrongRedirect.set('redirect_uri', 'https://evil.example/callback');
    expect((await app.request(`/dashboard/native/authorize?${wrongRedirect}`, bearer('alex'))).status).toBe(422);
    const crossOrigin = await app.request('/dashboard/native/authorize', { method: 'POST', headers: { Authorization: 'Bearer alex', Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: query(challenge).toString() });
    expect(crossOrigin.status).toBe(403);
  });

  it('burns a code after a wrong verifier and never accepts a code twice', async () => {
    const { app } = setup(); const { verifier, challenge } = pkce(); const code = await authorize(app, 'alex', challenge);
    expect((await exchange(app, { grantType: 'authorization_code', code, codeVerifier: pkce().verifier })).status).toBe(401);
    expect((await exchange(app, { grantType: 'authorization_code', code, codeVerifier: verifier })).status).toBe(401);
    const tokens = await signIn(app);
    expect(tokens.member.id).toBe('m1');
  });
});

describe('native API mount', () => {
  it('reuses browser handlers with member isolation and no CSRF ceremony', async () => {
    const { app, db } = setup(); const alex = await signIn(app, 'alex'); const sam = await signIn(app, 'sam');
    const me = await app.request('/native/v1/me', bearer(alex.accessToken));
    expect((await me.json()).data.member.displayName).toBe('Alex');
    const planId = new PlanRepository(db, keyFromSecret(config.SESSION_SECRET)).createPrivate({ memberId: 'm1', householdId: 'h1' }, facts);
    expect((await app.request(`/native/v1/plans/${planId}`, bearer(alex.accessToken))).status).toBe(200);
    expect((await app.request(`/native/v1/plans/${planId}`, bearer(sam.accessToken))).status).toBe(404);
    const created = await app.request('/native/v1/lists/grocery/items', { method: 'POST', headers: { Authorization: `Bearer ${alex.accessToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'native-grocery-1' }, body: JSON.stringify({ title: 'Oat milk' }) });
    expect(created.status).toBe(201);
    const list = await app.request('/native/v1/lists/grocery', bearer(sam.accessToken));
    expect((await list.json()).data.items.map((item: { title: string }) => item.title)).toEqual(['Oat milk']);
  });

  it('rejects missing tokens, browser-only routes and native tokens on the browser API', async () => {
    const { app } = setup(); const alex = await signIn(app);
    expect((await app.request('/native/v1/me')).status).toBe(401);
    expect((await app.request('/native/v1/me', bearer('mpa_forged'))).status).toBe(401);
    const google = await app.request('/native/v1/connection/google/start', { method: 'POST', headers: { Authorization: `Bearer ${alex.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ disclosureVersion: 'v1' }) });
    expect(google.status).toBe(404); expect((await google.json()).error.code).toBe('NATIVE_UNSUPPORTED');
    expect((await app.request('/dashboard/api/v1/me', bearer(alex.accessToken))).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the session when a rotated token is replayed', async () => {
    let now = Date.now(); const { app } = setup(() => new Date(now)); const first = await signIn(app);
    const rotated = await exchange(app, { grantType: 'refresh_token', refreshToken: first.refreshToken });
    expect(rotated.status).toBe(200); const second = (await rotated.json()).data as { accessToken: string; refreshToken: string };
    expect((await app.request('/native/v1/me', bearer(second.accessToken))).status).toBe(200);
    // A retry right after a lost response gets fresh tokens instead of a revocation.
    const retried = await exchange(app, { grantType: 'refresh_token', refreshToken: first.refreshToken });
    expect(retried.status).toBe(200);
    now += 60_000;
    expect((await exchange(app, { grantType: 'refresh_token', refreshToken: first.refreshToken })).status).toBe(401);
    expect((await app.request('/native/v1/me', bearer(second.accessToken))).status).toBe(401);
    expect((await exchange(app, { grantType: 'refresh_token', refreshToken: second.refreshToken })).status).toBe(401);
  });

  it('signs out and stops honoring tokens for a deactivated member', async () => {
    const { app, members } = setup(); const first = await signIn(app); const second = await signIn(app);
    const sessions = await app.request('/native/v1/native-sessions', bearer(first.accessToken));
    expect((await sessions.json()).data.sessions).toHaveLength(2);
    expect((await app.request('/native/v1/auth/logout', { method: 'POST', ...bearer(first.accessToken) })).status).toBe(204);
    expect((await app.request('/native/v1/me', bearer(first.accessToken))).status).toBe(401);
    expect((await app.request('/native/v1/me', bearer(second.accessToken))).status).toBe(200);
    members[0]!.active = false;
    expect((await app.request('/native/v1/me', bearer(second.accessToken))).status).toBe(401);
    expect((await exchange(app, { grantType: 'refresh_token', refreshToken: second.refreshToken })).status).toBe(401);
  });
});
