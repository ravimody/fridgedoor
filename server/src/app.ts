import { createTrialSummaryProvider } from './ai/relevance-summary.js';
import { RelevanceTrialService } from './services/relevance-trial.js';
import { registerRelevanceTrialRoutes } from './routes/relevance-trial.js';
import { MorningDigestService } from './services/morning-digest.js';
import { registerMorningDigestRoutes } from './routes/morning-digest.js';
import { BackgroundAiService } from './services/background-ai.js';
import { registerBackgroundAiRoutes } from './routes/background-ai.js';
import { backgroundAiEnabled } from './providers/ai.js';
import { LlmHub } from './llm/hub.js';
import { resolveAiConfig, SettingsStore } from './settings.js';
import { PlanDecisionService } from './services/plan-decisions.js';
import { AssistantService } from './ai/assistant-service.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { sessionResponseSchema } from '@fridgedoor/contracts';
import { bearerToken, type AccessVerifier, type MemberRecord } from './auth/access.js';
import { expiredCookie, readCookie, SessionStore, sessionCookie, type Clock } from './auth/session.js';
import type { AppConfig } from './config.js';
import { keyFromSecret } from './crypto.js';
import { migrate } from './db/migrate.js';
import { FakeGoogleProvider, type GoogleProvider } from './providers/google.js';
import { ConnectionService } from './services/connections.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { PlanRepository } from './repos/plans.js';
import { registerPlanRoutes } from './routes/plans.js';
import { JobQueue } from './jobs/queue.js';
import { CalendarActionService } from './services/calendar-actions.js';
import { registerActionRoutes } from './routes/actions.js';
import { CalendarRepository } from './repos/calendar.js';
import { registerAgendaRoutes } from './routes/agenda.js';
import { ListService } from './services/lists.js';
import { ChatService } from './ai/chat.js';
import { registerListRoutes } from './routes/lists.js';
import { registerChatRoutes } from './routes/chat.js';
import { ReminderService } from './services/reminders.js';
import { createPushProvider } from './providers/push.js';
import { registerPushSubscriptionRoutes } from './routes/push-subscriptions.js';
import { registerReminderRoutes } from './routes/reminders.js';
import { CaptureService } from './services/captures.js';
import { registerCaptureRoutes } from './routes/captures.js';
import { CaptureCredentialService } from './auth/capture.js';
import { registerShortcutCaptureRoutes, registerCaptureCredentialRoutes } from './routes/shortcut-capture.js';
import { DailyOverviewService } from './services/daily-overview.js';
import { createDailyOverviewProvider, type DailyOverviewProvider } from './ai/daily-overview.js';
import { registerDailyOverviewRoutes } from './routes/daily-overview.js';
import { ClarificationService } from './services/clarifications.js';
import { registerClarificationRoutes } from './routes/clarifications.js';
import { registerKnowledgeMaintenanceRoutes } from './routes/knowledge-maintenance.js';
import { createKnowledgeMaintenanceProvider, type KnowledgeMaintenanceProvider } from './ai/knowledge-maintenance.js';
import { KnowledgeMaintenanceService } from './services/knowledge-maintenance.js';
import { NativeAuthService, type NativeSession } from './auth/native.js';
import { registerNativeRoutes } from './routes/native.js';
import { AccountService, AttemptLimiter, loadActiveMembers } from './auth/accounts.js';
import { registerAccountRoutes, registerPublicAccountRoutes } from './routes/accounts.js';
import { registerAdminRoutes } from './routes/admin.js';
import { CalendarFeedService } from './services/calendar-feed.js';
import { digest } from './crypto.js';
import { errorBody, errorHandler, ROOT_STATUSES } from './errors.js';
import { CAPTURE_UPLOAD_LIMIT } from './services/captures.js';
import { MAX_AUDIO_BYTES, TranscriptionLimiter } from './providers/transcription.js';
import { bodyLimit } from 'hono/body-limit';
import { createHash } from 'node:crypto';

export type Variables = { requestId: string; identity: { subject: string }; session: ReturnType<SessionStore['find']>; nativeSessionId?: string };
// `verifyAccess` is only set when Cloudflare Access sits in front of the server; otherwise the session cookie from
// the built-in sign-in is the identity. `members` defaults to the database.
type Dependencies = { db: Database.Database; config: AppConfig; verifyAccess?: AccessVerifier | undefined; members?: () => MemberRecord[]; google?: GoogleProvider; dailyOverviewProvider?: DailyOverviewProvider; knowledgeMaintenanceProvider?: KnowledgeMaintenanceProvider; llm?: LlmHub; now?: Clock; webDist?: string; llmFetch?: typeof fetch };
const jsonError = (c: Context<{ Variables: Variables }>, status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 422, code: string, message: string) => c.json({ error: { code, message, requestId: c.get('requestId') ?? crypto.randomUUID() } }, status);
// Every request body is small JSON except uploads, which get their own limit and error code.
const BODY_LIMIT = 256 * 1024;
// `streamed` routes count bytes themselves while reading (captureInput), after checking the caller.
const UPLOAD_LIMITS: Array<{ path: RegExp; maxSize: number; code: string; message: string; streamed?: boolean }> = [
  { path: /^\/(?:dashboard\/api|native)\/v1\/captures$|^\/capture\/v1\/items$/, maxSize: CAPTURE_UPLOAD_LIMIT, code: 'CAPTURE_TOO_LARGE', message: 'Choose a file smaller than 10 MB.', streamed: true },
  { path: /^\/(?:dashboard\/api|native)\/v1\/assistant\/transcribe$/, maxSize: MAX_AUDIO_BYTES + 65536, code: 'INVALID_AUDIO', message: 'That recording is too long.' },
];
const CONTENT_TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const requestIdOf = (value: string | undefined) => value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : crypto.randomUUID();
// The built web app loads only its own scripts and styles; the QR code is a data: image. Invite and
// setup links carry tokens in the URL, so no referrer leaves the page.
const securityHeaders = (html?: string) => ({
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'${inlineStyleHashes(html)}; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
});
/** Hashes of a page's own <style> blocks (the offline page), so they're allowed without 'unsafe-inline'. */
const inlineStyleHashes = (html?: string) => [...(html ?? '').matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => ` 'sha256-${createHash('sha256').update(match[1] ?? '').digest('base64')}'`).join('');
const publicMember = (member: MemberRecord) => ({ id: member.id, householdId: member.householdId, displayName: member.displayName, timezone: member.timezone });
export function createApp(deps: Dependencies) {
  const members = deps.members ?? (() => loadActiveMembers(deps.db)); const clock = deps.now ?? (() => new Date());
  const accounts = new AccountService(deps.db, clock); const settings = new SettingsStore(deps.db, deps.config.SESSION_SECRET, clock); const limiter = new AttemptLimiter(10, 15 * 60_000, clock);
  const secure = () => deps.config.APP_ORIGIN.startsWith('https:'); const loadMember = (id: string) => members().find((candidate) => candidate.id === id) ?? null;
  // Sessions made before the key was derived with SHA-256 still open with the old key.
  migrate(deps.db); const store = new SessionStore(deps.db, keyFromSecret(deps.config.SESSION_SECRET), deps.now, Buffer.from(deps.config.SESSION_SECRET).subarray(0, 32)); const app = new Hono<{ Variables: Variables }>(); const connectionService = new ConnectionService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), deps.google ?? new FakeGoogleProvider(), deps.config.APP_ORIGIN, deps.now ?? (() => new Date()));
  // Requests re-dispatched by the /native/v1 mount carry a verified native session.
  // Only in-process Request objects can be keys here; no header can claim this identity.
  const nativeRequests = new WeakMap<Request, NativeSession>();
  app.onError(errorHandler(ROOT_STATUSES));
  app.use('*', async (c, next) => { c.set('requestId', requestIdOf(c.req.header('X-Request-Id'))); c.header('X-Request-Id', c.get('requestId')); await next(); });
  // Before anything reads a body. A re-dispatched native request was already limited on its way in.
  const limits = new Map(UPLOAD_LIMITS.map((limit) => [limit, limit.streamed ? (async (c, next) => Number(c.req.header('Content-Length') ?? 0) > limit.maxSize ? c.json(errorBody(c, limit.code, limit.message), 413) : next()) satisfies MiddlewareHandler : bodyLimit({ maxSize: limit.maxSize, onError: (c) => c.json(errorBody(c, limit.code, limit.message), 413) })]));
  const defaultLimit = bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json(errorBody(c, 'PAYLOAD_TOO_LARGE', 'That request is too large.'), 413) });
  app.use('*', async (c, next) => { if (nativeRequests.has(c.req.raw)) return next(); const upload = UPLOAD_LIMITS.find((limit) => limit.path.test(c.req.path)); return (upload ? limits.get(upload)! : defaultLimit)(c, next); });
  // HSTS only when the browser really used HTTPS: the address is https and the trusted proxy says so.
  const hsts = (c: Context<{ Variables: Variables }>): Record<string, string> => secure() && deps.config.TRUST_PROXY === 'true' && c.req.header('X-Forwarded-Proto') === 'https' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {};
  app.use('/dashboard/*', async (c, next) => { await next(); for (const [name, value] of Object.entries({ ...securityHeaders(), ...hsts(c) })) if (!c.res.headers.has(name)) c.res.headers.set(name, value); });
  app.get('/healthz', (c) => {
    const heartbeat = deps.db.prepare("SELECT last_seen_at as lastSeenAt FROM worker_health WHERE id = 'fridgedoor-worker'").get() as { lastSeenAt: string } | undefined;
    const now = (deps.now ?? (() => new Date()))().getTime();
    const lastSeen = heartbeat ? Date.parse(heartbeat.lastSeenAt) : now;
    if (heartbeat && (!Number.isFinite(lastSeen) || now - lastSeen > 60_000)) return c.json({ data: { status: 'degraded' } }, 503);
    return c.json({ data: { status: 'ok' } });
  });
  const accessToken = (c: { req: { header: (name: string) => string | undefined } }) => bearerToken(c.req.header('Authorization')) ?? c.req.header('CF-Access-Jwt-Assertion') ?? '';
  // The outer Access identity when configured; otherwise the member behind the built-in sign-in cookie.
  const browserIdentity = async (c: { req: { header: (name: string) => string | undefined } }) => { if (deps.verifyAccess) return deps.verifyAccess(accessToken(c)); const session = store.lookup(readCookie(c.req.header('Cookie')), loadMember); return session ? { subject: session.member.accessSubject } : null; };
  const accountDeps = { accounts, store, config: deps.config, settings, limiter, accessMode: Boolean(deps.verifyAccess), ...(deps.verifyAccess ? { accessIdentity: (c: { req: { header: (name: string) => string | undefined } }) => deps.verifyAccess!(accessToken(c)) } : {}), memberById: (id: string) => loadMember(id) ?? undefined };
  registerPublicAccountRoutes(app, accountDeps);
  app.use('/dashboard/api/v1/*', async (c, next) => { const native = nativeRequests.get(c.req.raw); if (native) { c.set('identity', { subject: native.member.accessSubject }); c.set('session', { id: native.sessionId, member: native.member, csrfToken: '' }); c.set('nativeSessionId', native.sessionId); return next(); } if (c.req.path.startsWith('/dashboard/api/v1/auth/')) return next(); const identity = await browserIdentity(c); if (!identity) return jsonError(c, 401, 'UNAUTHENTICATED', 'Sign in required'); c.set('identity', identity); await next(); });
  // Signing the iPhone app in happens in the browser; send people who aren't signed in to the sign-in page first.
  app.use('/dashboard/native/*', async (c, next) => { const identity = await browserIdentity(c); if (!identity) { if (c.req.method === 'GET') { const url = new URL(c.req.url); return c.redirect(`/dashboard/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302); } return jsonError(c, 401, 'UNAUTHENTICATED', 'Sign in required'); } c.set('identity', identity); await next(); });
  app.use('/dashboard/google/*', async (c, next) => { const identity = await browserIdentity(c); if (!identity) return jsonError(c, 401, 'UNAUTHENTICATED', 'Sign in required'); c.set('identity', identity); await next(); });
  // X-Planner-Bootstrap is the header's older name, still sent by released clients.
  app.post('/dashboard/api/v1/session', async (c) => { if (c.req.header('X-Fridgedoor-Bootstrap') !== '1' && c.req.header('X-Planner-Bootstrap') !== '1') return jsonError(c, 403, 'FORBIDDEN', 'Bootstrap header required'); if (c.req.header('Origin') !== deps.config.APP_ORIGIN) return jsonError(c, 403, 'FORBIDDEN', 'Exact origin required'); const identity = c.get('identity') as { subject: string }; const member = members().find((candidate) => candidate.active && candidate.accessSubject === identity.subject); if (!member) return jsonError(c, 403, 'FORBIDDEN', 'Member is not allowed'); const existing = store.find(readCookie(c.req.header('Cookie')), member, (id) => members().find((candidate) => candidate.id === id) ?? null); const created = existing ? { token: null, data: existing } : store.create(member); if (created.token) c.header('Set-Cookie', sessionCookie(created.token, 604800, secure())); const body = { data: { member: publicMember(created.data.member), csrfToken: created.data.csrfToken } }; sessionResponseSchema.parse(body); c.header('Cache-Control', 'no-store'); return c.json(body); });
  app.use('/dashboard/api/v1/*', async (c, next) => { if (nativeRequests.has(c.req.raw)) return next(); if (c.req.path === '/dashboard/api/v1/session' && c.req.method === 'POST') return next(); if (c.req.path.startsWith('/dashboard/api/v1/auth/')) return next(); const identity = c.get('identity') as { subject: string }; const member = members().find((candidate) => candidate.active && candidate.accessSubject === identity.subject); const session = store.find(readCookie(c.req.header('Cookie')), member ?? ({ id: '', active: false } as MemberRecord), (id) => members().find((candidate) => candidate.id === id) ?? null); if (!session) return jsonError(c, 401, 'UNAUTHENTICATED', 'Active browser session required'); c.set('session', session); if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) { if (c.req.header('Origin') !== deps.config.APP_ORIGIN || !store.verifyCsrf(session, c.req.header('X-CSRF-Token'))) return jsonError(c, 403, 'FORBIDDEN', 'Origin and CSRF checks required'); } await next(); });
  // `household` lists the active members of the caller's household (id and name only) so clients can show and assign people.
  app.get('/dashboard/api/v1/me', (c) => { const session = c.get('session') as { member: MemberRecord }; const household = members().filter((candidate) => candidate.active && candidate.householdId === session.member.householdId).map((candidate) => ({ id: candidate.id, displayName: candidate.displayName })); return c.json({ data: { member: publicMember(session.member), household, householdName: accounts.householdName(session.member.householdId), ...(accounts.email(session.member.id) ? { email: accounts.email(session.member.id) } : {}), role: accounts.role(session.member.id) ?? 'member', canManage: accounts.canManage(session.member) } }, 200, { 'Cache-Control': 'no-store' }); });
  registerAccountRoutes(app, accountDeps);
  const calendarFeed = new CalendarFeedService(deps.db, new PlanRepository(deps.db, keyFromSecret(deps.config.SESSION_SECRET), clock), clock);
  const feedUrls = (token: string) => { const url = `${deps.config.APP_ORIGIN}/calendar/v1/${token}.ics`; return { url, webcalUrl: url.replace(/^https?:/, 'webcal:') }; };
  app.get('/dashboard/api/v1/calendar-feed', (c) => c.json({ data: calendarFeed.status((c.get('session') as { member: MemberRecord }).member.id) }, 200, { 'Cache-Control': 'no-store' }));
  app.post('/dashboard/api/v1/calendar-feed', (c) => c.json({ data: { active: true, ...feedUrls(calendarFeed.create((c.get('session') as { member: MemberRecord }).member.id)) } }, 201, { 'Cache-Control': 'no-store' }));
  app.delete('/dashboard/api/v1/calendar-feed', (c) => c.json({ data: calendarFeed.revoke((c.get('session') as { member: MemberRecord }).member.id) }));
  // Public: the unguessable token in the path is the credential (calendar apps can't sign in).
  app.get('/calendar/v1/:file', (c) => { const token = c.req.param('file').replace(/\.ics$/, ''); const member = deps.db.prepare('SELECT m.household_id as householdId FROM calendar_feeds f JOIN members m ON m.id = f.member_id WHERE f.token_digest = ? AND f.revoked_at IS NULL').get(digest(token)) as { householdId: string } | undefined; const body = member ? calendarFeed.render(token, deps.config.APP_ORIGIN, `${accounts.householdName(member.householdId)} (Fridgedoor)`) : null; return body ? c.body(body, 200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300' }) : jsonError(c, 404, 'NOT_FOUND', 'Not found'); }); registerAdminRoutes(app, { accounts, settings, config: deps.config, ...(deps.llmFetch ? { fetch: deps.llmFetch } : {}) });
  app.delete('/dashboard/api/v1/session', (c) => { const session = c.get('session') as { id: string }; store.revoke(session.id); c.header('Set-Cookie', expiredCookie(secure())); return c.body(null, 204); });
  registerConnectionRoutes(app, { service: connectionService, canManage: (member) => accounts.canManage(member), googleAvailable: () => Boolean(deps.config.GOOGLE_CLIENT_ID && deps.config.GOOGLE_CLIENT_SECRET), memberFor: (subject) => members().find((candidate) => candidate.active && candidate.accessSubject === subject) });
  const planRepository = new PlanRepository(deps.db, keyFromSecret(deps.config.SESSION_SECRET), deps.now ?? (() => new Date())); registerPlanRoutes(app, { plans: planRepository, memberFor: (subject) => members().find((candidate) => candidate.active && candidate.accessSubject === subject) });
  const actionQueue = new JobQueue(deps.db, deps.now ?? (() => new Date())); const actionService = new CalendarActionService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), actionQueue, deps.google ?? new FakeGoogleProvider(), deps.now ?? (() => new Date())); registerActionRoutes(app, { actions: actionService, decisions: new PlanDecisionService(deps.db, planRepository, actionService, deps.now), memberFor: (subject) => members().find((candidate) => candidate.active && candidate.accessSubject === subject) });
  registerAgendaRoutes(app, { calendars: new CalendarRepository(deps.db, keyFromSecret(deps.config.SESSION_SECRET), deps.now ?? (() => new Date())), memberFor: (subject) => members().find((candidate) => candidate.active && candidate.accessSubject === subject) });
  const listService = new ListService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), deps.now ?? (() => new Date())); registerListRoutes(app, { lists: listService, memberFor: (subject) => members().find((candidate) => candidate.active && candidate.accessSubject === subject) }); registerChatRoutes(app, { chat: new ChatService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), listService, deps.now ?? (() => new Date()), planRepository), memberFor: (subject) => members().find((candidate) => candidate.active && candidate.accessSubject === subject) });
  const reminderService = new ReminderService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), createPushProvider(deps.config), deps.now ?? (() => new Date())); registerPushSubscriptionRoutes(app, { reminders: reminderService, memberFor: (subject) => members().find((candidate) => candidate.active && candidate.accessSubject === subject) }); registerReminderRoutes(app, { reminders: reminderService, memberFor: (subject) => members().find((candidate) => candidate.active && candidate.accessSubject === subject) });
  app.get('/dashboard/api/v1/push-config', (c) => c.json({ data: { enabled: deps.config.PUSH_PROVIDER === 'webpush', publicKey: deps.config.VAPID_PUBLIC_KEY ?? null } }, 200, { 'Cache-Control': 'no-store' }));
  registerMorningDigestRoutes(app, new MorningDigestService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), createPushProvider(deps.config), deps.config.PUSH_PROVIDER === 'webpush', deps.now));
  const llm = deps.llm ?? new LlmHub(() => resolveAiConfig(deps.config, new SettingsStore(deps.db, deps.config.SESSION_SECRET)));
  const dailyOverviewQueue = new JobQueue(deps.db, deps.now ?? (() => new Date())); registerDailyOverviewRoutes(app, new DailyOverviewService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), deps.dailyOverviewProvider ?? createDailyOverviewProvider(llm, deps.config), () => llm.model('main') ?? 'unconfigured', deps.now ?? (() => new Date())), dailyOverviewQueue); registerClarificationRoutes(app, new ClarificationService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), deps.now ?? (() => new Date())));
  registerRelevanceTrialRoutes(app, new RelevanceTrialService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), deps.now, createTrialSummaryProvider(llm, deps.config)));
  registerKnowledgeMaintenanceRoutes(app, new KnowledgeMaintenanceService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), deps.knowledgeMaintenanceProvider ?? createKnowledgeMaintenanceProvider(llm, deps.config), () => llm.model('main') ?? 'unconfigured', deps.now ?? (() => new Date())));
  registerBackgroundAiRoutes(app, new BackgroundAiService(deps.db, () => backgroundAiEnabled(llm, deps.config), deps.now, () => ({ provider: llm.config()?.provider, model: llm.model('email') })));
  registerAssistantRoutes(app, new AssistantService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), () => llm.configured() && deps.config.ASSISTANT_ENABLED !== 'false', undefined, deps.now, new PlanDecisionService(deps.db, planRepository, actionService, deps.now)), llm, new TranscriptionLimiter(deps.db, clock));
  const captureService = new CaptureService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), deps.now ?? (() => new Date())); registerCaptureRoutes(app, { captures: captureService, memberFor: (subject) => members().find((candidate) => candidate.active && candidate.accessSubject === subject) });
  const captureCredentials = new CaptureCredentialService(deps.db, deps.now ?? (() => new Date())); registerShortcutCaptureRoutes(app, { credentials: captureCredentials, limiter: new AttemptLimiter(30, 60 * 60_000, clock), captures: new CaptureService(deps.db, keyFromSecret(deps.config.SESSION_SECRET), deps.now, (actor, captureId) => {
    actionQueue.enqueue({ kind: 'capture_dispatch', scopeId: `capture:${actor.memberId}`, dedupeKey: `capture-dispatch:${captureId}`, payload: { captureId } });
  }), memberFor: (id) => members().find((candidate) => candidate.active && candidate.id === id) }); registerCaptureCredentialRoutes(app, { credentials: captureCredentials, captures: captureService, memberFor: (subject) => members().find((candidate) => candidate.active && candidate.accessSubject === subject) });
  const memberById = (id: string) => members().find((candidate) => candidate.active && candidate.id === id);
  registerNativeRoutes(app, { auth: new NativeAuthService(deps.db, memberById, deps.now), accounts, origin: () => deps.config.APP_ORIGIN, memberFor: (subject) => members().find((candidate) => candidate.active && candidate.accessSubject === subject), dispatch: (request, session) => { nativeRequests.set(request, session); return app.fetch(request); } });
  app.get('/dashboard/google/callback', async (c) => { const identity = c.get('identity') as { subject: string }; const member = members().find((candidate) => candidate.active && candidate.accessSubject === identity.subject); const session = store.find(readCookie(c.req.header('Cookie')), member ?? ({ id: '', active: false } as MemberRecord), (id) => members().find((candidate) => candidate.id === id) ?? null); if (!member || !session) return c.redirect('/dashboard/settings?oauth=expired'); try { await connectionService.callback(member, session, c.req.query('state') ?? '', c.req.query('code') ?? ''); return c.redirect('/dashboard/settings?oauth=success'); } catch (error) { const code = error instanceof Error && ['GOOGLE_ACCOUNT_MISMATCH','GOOGLE_SCOPES_INSUFFICIENT'].includes(error.message) ? error.message.toLowerCase() : 'failed'; return c.redirect(`/dashboard/settings?oauth=${encodeURIComponent(code)}`); } });
  if (deps.webDist) { const webRoot = resolve(deps.webDist); const file = (relative: string) => { const path = resolve(webRoot, relative); return path.startsWith(`${webRoot}/`) || path === webRoot ? path : undefined; }; const contentType = (path: string) => CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'; app.get('/pwa/*', (c) => { const relative = c.req.path.slice('/pwa/'.length); const target = file(relative); if (!target || !existsSync(target)) return jsonError(c, 404, 'NOT_FOUND', 'Not found'); const body = readFileSync(target); return new Response(body, { headers: { ...securityHeaders(target.endsWith('.html') ? body.toString('utf8') : undefined), ...hsts(c), 'Content-Type': contentType(target), ...(relative === 'sw.js' ? { 'Service-Worker-Allowed': '/dashboard/' } : {}), ...(target.includes('/assets/') ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : { 'Cache-Control': 'no-store' }) } }); }); app.get('/dashboard/*', (c) => { const target = file('index.html'); if (!target || !existsSync(target)) return c.text('Dashboard shell is served by the web package in production.', 200); return new Response(readFileSync(target), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }); }); }
  app.all('/dashboard/api/v1/*', (c) => jsonError(c, 404, 'NOT_FOUND', 'Not found'));
  app.all('/dashboard/google/*', (c) => jsonError(c, 404, 'NOT_FOUND', 'Not found'));
  if (!deps.webDist) app.get('/dashboard/*', (c) => c.text('Dashboard shell is served by the web package in production.', 200));
  app.get('/', (c) => c.redirect('/dashboard/')); app.all('*', (c) => jsonError(c, 404, 'NOT_FOUND', 'Not found')); return app;
}
