import type { Context, Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import QRCode from 'qrcode';
import { z, ZodError } from 'zod';
import type { Variables } from '../app.js';
import type { MemberRecord } from '../auth/access.js';
import { profileInput, setupInput, type AccountService, type AttemptLimiter } from '../auth/accounts.js';
import { sessionCookie, type SessionStore } from '../auth/session.js';
import type { AppConfig } from '../config.js';
import type { SettingsStore } from '../settings.js';

type C = Context<{ Variables: Variables }>;
type Deps = {
  accounts: AccountService;
  store: SessionStore;
  config: AppConfig;
  settings: SettingsStore;
  limiter: AttemptLimiter;
  accessMode: boolean;
  /** The verified Cloudflare Access identity of the request, when the server runs behind Access. */
  accessIdentity?: (c: C) => Promise<{ subject: string } | null>;
  memberById: (id: string) => MemberRecord | undefined;
};

const fail = (c: C, status: 400 | 401 | 403 | 404 | 409 | 422 | 429, code: string) => c.json({ error: { code, message: code.replaceAll('_', ' ').toLowerCase(), requestId: c.get('requestId') } }, status, { 'Cache-Control': 'no-store' });
const publicMember = (member: MemberRecord) => ({ id: member.id, householdId: member.householdId, displayName: member.displayName, timezone: member.timezone });
const failure = (c: C, error: unknown) => {
  if (error instanceof ZodError || error instanceof SyntaxError) return fail(c, 422, 'VALIDATION');
  const code = error instanceof Error ? error.message : '';
  if (code === 'FORBIDDEN') return fail(c, 403, code);
  if (code === 'NOT_FOUND' || code === 'INVITE_INVALID') return fail(c, 404, code);
  if (['EMAIL_IN_USE', 'SETUP_ALREADY_DONE', 'CANNOT_REMOVE_SELF', 'ALREADY_MEMBER', 'MEMBER_REMOVED'].includes(code)) return fail(c, 409, code);
  if (code === 'PASSWORD_INCORRECT') return fail(c, 403, code);
  throw error;
};
/** The caller's address: the socket peer, or the last X-Forwarded-For hop when TRUST_PROXY says a proxy sets it. */
export function clientAddress(c: C, trustProxy: boolean) {
  if (trustProxy) { const forwarded = c.req.header('X-Forwarded-For')?.split(',').map((part) => part.trim()).filter(Boolean).at(-1); if (forwarded) return forwarded; }
  try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
}
const sameSecret = (a: string, b: string) => { const left = createHash('sha256').update(a).digest(); const right = createHash('sha256').update(b).digest(); return timingSafeEqual(left, right); };

/** The setup link: SETUP_TOKEN from the environment, otherwise the one generated at first start. */
export function setupToken(config: AppConfig, settings: SettingsStore) { return config.SETUP_TOKEN ?? settings.get('setup_token'); }

export function pairingLink(origin: string, code: string) { return `fridgedoor://pair?server=${encodeURIComponent(origin)}&code=${encodeURIComponent(code)}`; }

/** Sign-in, first-run setup and invites. Registered before the session middleware; everything here is public. */
export function registerPublicAccountRoutes(app: Hono<{ Variables: Variables }>, deps: Deps) {
  const secure = () => deps.config.APP_ORIGIN.startsWith('https:');
  const start = (c: C, member: MemberRecord) => {
    const created = deps.store.create(member);
    c.header('Set-Cookie', sessionCookie(created.token, 604800, secure()));
    return c.json({ data: { member: publicMember(member), csrfToken: created.data.csrfToken } }, 200, { 'Cache-Control': 'no-store' });
  };
  const sameOrigin = (c: C) => c.req.header('Origin') === deps.config.APP_ORIGIN;

  app.get('/dashboard/api/v1/auth/status', (c) => c.json({ data: { setupRequired: deps.accounts.setupRequired(), accessMode: deps.accessMode, publicUrl: deps.config.APP_ORIGIN } }, 200, { 'Cache-Control': 'no-store' }));

  app.post('/dashboard/api/v1/auth/setup', async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const expected = setupToken(deps.config, deps.settings);
      if (!deps.accounts.setupRequired()) return fail(c, 409, 'SETUP_ALREADY_DONE');
      if (!deps.limiter.allow(`setup:${clientAddress(c, deps.config.TRUST_PROXY === 'true')}`)) return fail(c, 429, 'TOO_MANY_ATTEMPTS');
      if (!expected || typeof body.token !== 'string' || !sameSecret(body.token, expected)) return fail(c, 403, 'SETUP_TOKEN_INVALID');
      // Before setup the server may not know its public address yet: accept the address
      // the browser used when it matches the Host header, and remember it.
      const origin = c.req.header('Origin');
      if (deps.config.ORIGIN_FROM_ENV) { if (origin !== deps.config.APP_ORIGIN) return fail(c, 403, 'FORBIDDEN'); }
      else {
        let host: string | undefined;
        try { host = origin ? new URL(origin).host : undefined; } catch { host = undefined; }
        const seen = [c.req.header('X-Forwarded-Host'), c.req.header('Host')].filter(Boolean);
        if (!host || !seen.includes(host)) return fail(c, 403, 'FORBIDDEN');
      }
      const { token: _token, ...profile } = body; void _token;
      const member = await deps.accounts.createHousehold(setupInput.parse(profile));
      if (!deps.config.ORIGIN_FROM_ENV && origin) { deps.config.APP_ORIGIN = new URL(origin).origin; deps.settings.set('public_url', deps.config.APP_ORIGIN); }
      deps.settings.delete('setup_token');
      return start(c, member);
    } catch (error) { return failure(c, error); }
  });

  app.post('/dashboard/api/v1/auth/login', async (c) => {
    if (!sameOrigin(c)) return fail(c, 403, 'FORBIDDEN');
    try {
      const input = z.object({ email: z.string().trim().max(254), password: z.string().max(200) }).strict().parse(await c.req.json());
      // Only failures count. The per-account limit is looser so a stranger can't keep
      // someone locked out; the per-address limits catch guessing from one place.
      const address = clientAddress(c, deps.config.TRUST_PROXY === 'true'); const account = input.email.trim().toLowerCase();
      const keys = [`login-ip:${address}`, `login:${account}:${address}`];
      if (deps.limiter.blocked(keys[0]!, 30) || deps.limiter.blocked(keys[1]!) || deps.limiter.blocked(`login:${account}`, 50)) return fail(c, 429, 'TOO_MANY_ATTEMPTS');
      const member = await deps.accounts.login(input.email, input.password);
      if (!member) { for (const key of [...keys, `login:${account}`]) deps.limiter.fail(key); return fail(c, 401, 'SIGN_IN_FAILED'); }
      deps.limiter.reset(keys[1]!);
      return start(c, member);
    } catch (error) { return failure(c, error); }
  });

  app.get('/dashboard/api/v1/auth/invites/:token', (c) => {
    const info = deps.accounts.inviteInfo(c.req.param('token'));
    return info ? c.json({ data: info }, 200, { 'Cache-Control': 'no-store' }) : fail(c, 404, 'INVITE_INVALID');
  });

  app.post('/dashboard/api/v1/auth/invites/:token', async (c) => {
    if (!sameOrigin(c)) return fail(c, 403, 'FORBIDDEN');
    // Behind Access the joiner must arrive with a verified identity, which becomes the new member's subject.
    const identity = deps.accessIdentity ? await deps.accessIdentity(c) : undefined;
    if (identity === null) return fail(c, 401, 'UNAUTHENTICATED');
    try { return start(c, await deps.accounts.acceptInvite(c.req.param('token'), profileInput.parse(await c.req.json()), identity?.subject)); }
    catch (error) { return failure(c, error); }
  });
}

/** Household management, password changes and phone pairing for a signed-in member. */
export function registerAccountRoutes(app: Hono<{ Variables: Variables }>, deps: Deps) {
  const member = (c: C) => (c.get('session') as { member: MemberRecord }).member;
  const sessionId = (c: C) => (c.get('session') as { id: string }).id;

  app.get('/dashboard/api/v1/household', (c) => c.json({ data: deps.accounts.household(member(c)) }, 200, { 'Cache-Control': 'no-store' }));
  app.patch('/dashboard/api/v1/household', async (c) => {
    try { if (!deps.accounts.canManage(member(c))) return fail(c, 403, 'FORBIDDEN'); return c.json({ data: deps.accounts.renameHousehold(member(c), z.object({ name: z.string() }).strict().parse(await c.req.json()).name) }); }
    catch (error) { return failure(c, error); }
  });
  app.post('/dashboard/api/v1/household/invites', (c) => {
    try { const invite = deps.accounts.createInvite(member(c)); return c.json({ data: { id: invite.id, expiresAt: invite.expiresAt, url: `${deps.config.APP_ORIGIN}/dashboard/join/${invite.token}` } }, 201, { 'Cache-Control': 'no-store' }); }
    catch (error) { return failure(c, error); }
  });
  app.delete('/dashboard/api/v1/household/invites/:id', (c) => { try { return c.json({ data: deps.accounts.revokeInvite(member(c), c.req.param('id')) }); } catch (error) { return failure(c, error); } });
  app.patch('/dashboard/api/v1/household/members/:id', async (c) => {
    try { const input = z.object({ active: z.boolean() }).strict().parse(await c.req.json()); return c.json({ data: deps.accounts.setActive(member(c), c.req.param('id'), input.active) }); }
    catch (error) { return failure(c, error); }
  });
  app.post('/dashboard/api/v1/account/password', async (c) => {
    try {
      const input = z.object({ currentPassword: z.string().max(200), newPassword: z.string() }).strict().parse(await c.req.json());
      if (deps.limiter.blocked(`password:${member(c).id}`)) return fail(c, 429, 'TOO_MANY_ATTEMPTS');
      try { await deps.accounts.changePassword(member(c), input.currentPassword, input.newPassword, sessionId(c)); }
      catch (error) { if (error instanceof Error && error.message === 'PASSWORD_INCORRECT') deps.limiter.fail(`password:${member(c).id}`); throw error; }
      return c.json({ data: { changed: true } });
    } catch (error) { return failure(c, error); }
  });
  app.post('/dashboard/api/v1/devices/pairing', async (c) => {
    const pairing = deps.accounts.createPairingCode(member(c));
    const link = pairingLink(deps.config.APP_ORIGIN, pairing.code);
    const qrSvg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return c.json({ data: { link, qrSvg, expiresAt: pairing.expiresAt } }, 201, { 'Cache-Control': 'no-store' });
  });
}
