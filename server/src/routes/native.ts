import { z, ZodError } from 'zod';
import type { Context, Hono } from 'hono';
import type { Variables } from '../app.js';
import type { MemberRecord } from '../auth/access.js';
import { bearerToken } from '../auth/access.js';
import type { AccountService } from '../auth/accounts.js';
import { NATIVE_REDIRECT_URI, type NativeAuthService, type NativeSession } from '../auth/native.js';

type Deps = {
  auth: NativeAuthService;
  /** Resolves pairing codes made on the web app's Settings → iPhone page. */
  accounts?: Pick<AccountService, 'consumePairingCode'>;
  origin: () => string;
  memberFor: (subject: string) => MemberRecord | undefined;
  // Re-enters the app at the browser API path with an already-verified native identity.
  dispatch: (request: Request, session: NativeSession) => Response | Promise<Response>;
};
type C = Context<{ Variables: Variables }>;

// Browser-only flows: cookie bootstrap, Web Push enrollment, and Google consent
// (its OAuth attempt is bound to a browser session). The app opens Safari for Google.
const blocked: Array<[string, RegExp]> = [['POST', /^\/session$/], ['DELETE', /^\/session$/], ['POST', /^\/connection\/google\/start$/], ['POST', /^\/push-subscriptions$/]];
const tokenInput = z.discriminatedUnion('grantType', [
  z.object({ grantType: z.literal('authorization_code'), code: z.string().min(1).max(200), codeVerifier: z.string().min(1).max(200), deviceLabel: z.string().max(80).default('iPhone') }).strict(),
  z.object({ grantType: z.literal('refresh_token'), refreshToken: z.string().min(1).max(200) }).strict(),
  z.object({ grantType: z.literal('pairing_code'), code: z.string().min(1).max(200), deviceLabel: z.string().max(80).default('iPhone') }).strict(),
]);
const authorizeQuery = z.object({ code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'), state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), redirect_uri: z.literal(NATIVE_REDIRECT_URI) });
const fail = (c: C, status: 400 | 401 | 403 | 404 | 422, code: string) => c.json({ error: { code, message: code.replaceAll('_', ' ').toLowerCase(), requestId: c.get('requestId') } }, status, { 'Cache-Control': 'no-store' });
const publicMember = (member: MemberRecord) => ({ id: member.id, householdId: member.householdId, displayName: member.displayName, timezone: member.timezone });
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function authorizePage(member: MemberRecord, query: z.infer<typeof authorizeQuery>) {
  const hidden = Object.entries(query).map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Fridgedoor</title>
<style>:root{color-scheme:light dark;--paper:light-dark(#f0ebe1,#22262d);--card:light-dark(#e8e3da,#2a2f37);--ink:light-dark(#303846,#eae5dc);--muted:light-dark(#585f6c,#b2b8c2);--accent:light-dark(#455a7a,#acbfd9);--on-accent:light-dark(#f8f3e8,#212f45)}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,sans-serif}main{width:min(26rem,calc(100% - 3rem))}p.eyebrow{color:var(--accent);text-transform:uppercase;letter-spacing:.14em;font-size:.72rem;font-weight:700}h1{font:400 2.2rem/1.1 Georgia,serif;letter-spacing:-.03em;margin:.4rem 0 1rem}p{color:var(--muted);line-height:1.5}button{width:100%;margin-top:1.5rem;min-height:50px;border:0;border-radius:999px;background:var(--accent);color:var(--on-accent);font:600 1rem system-ui}</style></head>
<body><main><p class="eyebrow">Fridgedoor</p><h1>Sign in on this iPhone?</h1><p>The Fridgedoor app will be able to read and update your household plans as <strong>${escapeHtml(member.displayName)}</strong>. You can sign out from the app at any time.</p>
<form method="post" action="/dashboard/native/authorize">${hidden}<button type="submit">Continue as ${escapeHtml(member.displayName)}</button></form></main></body></html>`;
}

export function registerNativeRoutes(app: Hono<{ Variables: Variables }>, deps: Deps) {
  const currentMember = (c: C) => { const identity = c.get('identity') as { subject: string } | undefined; return identity ? deps.memberFor(identity.subject) : undefined; };

  // Signed-in browser (under /dashboard*): the person confirms, then the app receives a one-time code.
  app.get('/dashboard/native/authorize', (c) => {
    const member = currentMember(c); if (!member) return fail(c, 403, 'FORBIDDEN');
    const query = authorizeQuery.safeParse(c.req.query()); if (!query.success) return fail(c, 422, 'VALIDATION');
    return c.html(authorizePage(member, query.data), 200, { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' fridgedoor:; frame-ancestors 'none'" });
  });
  app.post('/dashboard/native/authorize', async (c) => {
    const member = currentMember(c); if (!member) return fail(c, 403, 'FORBIDDEN');
    if (c.req.header('Origin') !== deps.origin()) return fail(c, 403, 'FORBIDDEN');
    const query = authorizeQuery.safeParse(Object.fromEntries(Object.entries(await c.req.parseBody()).filter(([, value]) => typeof value === 'string'))); if (!query.success) return fail(c, 422, 'VALIDATION');
    const code = deps.auth.createCode(member, query.data.code_challenge);
    const target = new URL(NATIVE_REDIRECT_URI); target.searchParams.set('code', code); target.searchParams.set('state', query.data.state);
    return c.redirect(target.toString(), 303);
  });

  // Public: the one-time code, pairing code or refresh token is the credential.
  app.post('/native/v1/auth/token', async (c) => {
    try {
      const input = tokenInput.parse(await c.req.json());
      const result = input.grantType === 'authorization_code' ? deps.auth.exchangeCode(input.code, input.codeVerifier, input.deviceLabel)
        : input.grantType === 'pairing_code' ? deps.auth.startSession(deps.accounts?.consumePairingCode(input.code) ?? '', input.deviceLabel)
        : deps.auth.refresh(input.refreshToken);
      return c.json({ data: { ...result.tokens, member: publicMember(result.member) } }, 200, { 'Cache-Control': 'no-store' });
    } catch (value) {
      if (value instanceof ZodError || value instanceof SyntaxError) return fail(c, 422, 'VALIDATION');
      if (value instanceof Error && /^PAIRING_CODE_(USED|EXPIRED|INVALID)$/.test(value.message)) return fail(c, 401, value.message);
      return fail(c, 401, 'NATIVE_GRANT_INVALID');
    }
  });

  const session = (c: C) => deps.auth.verify(bearerToken(c.req.header('Authorization')) ?? '');
  app.post('/native/v1/auth/logout', (c) => { const current = session(c); if (!current) return fail(c, 401, 'UNAUTHENTICATED'); deps.auth.revoke(current.member.id, current.sessionId); return c.body(null, 204); });
  app.get('/native/v1/native-sessions', (c) => { const current = session(c); if (!current) return fail(c, 401, 'UNAUTHENTICATED'); return c.json({ data: { currentId: current.sessionId, sessions: deps.auth.list(current.member.id) } }, 200, { 'Cache-Control': 'no-store' }); });
  app.delete('/native/v1/native-sessions/:id', (c) => { const current = session(c); if (!current) return fail(c, 401, 'UNAUTHENTICATED'); try { return c.json({ data: deps.auth.revoke(current.member.id, c.req.param('id')) }); } catch { return fail(c, 404, 'NOT_FOUND'); } });

  app.all('/native/v1/*', async (c) => {
    const current = session(c); if (!current) return fail(c, 401, 'UNAUTHENTICATED');
    // Checked against the decoded path, the one routing will see, so /%73ession can't slip past.
    const incoming = new URL(c.req.url); const rest = incoming.pathname.slice('/native/v1'.length);
    if (blocked.some(([method, path]) => method === c.req.method && path.test(c.req.path.slice('/native/v1'.length)))) return fail(c, 404, 'NATIVE_UNSUPPORTED');
    const headers = new Headers(c.req.raw.headers); for (const name of ['Authorization', 'Cookie', 'CF-Access-Jwt-Assertion', 'Origin', 'X-CSRF-Token']) headers.delete(name);
    const hasBody = !['GET', 'HEAD'].includes(c.req.method);
    const target = new URL(`/dashboard/api/v1${rest}${incoming.search}`, incoming.origin);
    const forwarded = new Request(target, { method: c.req.method, headers, ...(hasBody ? { body: c.req.raw.body, duplex: 'half' } : {}) } as RequestInit);
    return deps.dispatch(forwarded, current);
  });
}
