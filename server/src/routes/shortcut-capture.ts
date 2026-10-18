import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Hono } from 'hono';
import type { Variables } from '../app.js';
import type { MemberRecord } from '../auth/access.js';
import { bearerToken } from '../auth/access.js';
import type { CaptureCredentialService } from '../auth/capture.js';
import type { AttemptLimiter } from '../auth/accounts.js';
import { codeOrThrow } from '../errors.js';
import { CAPTURE_UPLOAD_LIMIT, type CaptureService, type CaptureInput } from '../services/captures.js';
import { validateCaptureUrl } from '../services/url-capture.js';
/** `limiter` caps how often one credential can add items (a leaked token can't flood the inbox). */
type D = { credentials: CaptureCredentialService; captures: CaptureService; memberFor: (id: string) => MemberRecord|undefined; limiter?: AttemptLimiter };
const errorResponse = (c: { json: (body: unknown, status: 400|401|404|409|413|422|429) => Response; get: (key: 'requestId') => string }, value: unknown) => { const code = codeOrThrow(value); const status = code === 'VALIDATION' ? 422 : code === 'CAPTURE_TOO_LARGE' ? 413 : code === 'NOT_FOUND' ? 404 : code === 'CAPTURE_IDEMPOTENCY_CONFLICT' ? 409 : code === 'CAPTURE_CREDENTIAL_INVALID' || code === 'UNAUTHENTICATED' ? 401 : code === 'CAPTURE_RATE_LIMITED' || code === 'CAPTURE_STORAGE_FULL' ? 429 : 400; return c.json({ error: { code, message: code.replaceAll('_', ' ').toLowerCase(), requestId: c.get('requestId') } }, status as 400|401|404|409|413|422|429); };
export { errorResponse as captureErrorResponse };
/** Reads a capture body (JSON text/URL, or one multipart file) without buffering more than the upload limit. */
export async function captureInput(request: Request): Promise<CaptureInput> {
  const limit = CAPTURE_UPLOAD_LIMIT;
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { void reader.cancel().catch(() => {}); throw new Error('CAPTURE_TOO_LARGE'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const body = new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' } });
  if (request.headers.get('Content-Type')?.toLowerCase().startsWith('multipart/form-data')) {
    let form: FormData;
    try { form = await body.formData(); } catch { throw new Error('VALIDATION'); }
    if ([...form.keys()].some((key) => !['clientCaptureId', 'file'].includes(key)) || form.getAll('file').length !== 1 || form.getAll('clientCaptureId').length !== 1) throw new Error('VALIDATION');
    const clientCaptureId = z.string().uuid().parse(form.get('clientCaptureId'));
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new Error('VALIDATION');
    return { clientCaptureId, file };
  }
  let json: unknown;
  try { json = await body.json(); } catch { throw new Error('VALIDATION'); }
  return z.object({ clientCaptureId: z.string().uuid(), text: z.string().max(8000).optional(), url: z.string().url().max(2000).optional() }).strict().parse(json);
}

export function registerShortcutCaptureRoutes(app: Hono<{ Variables: Variables }>, d: D) {
  const credentialId = (c: { req: { header(name: string): string|undefined } }) => d.credentials.verify(bearerToken(c.req.header('Authorization')) ?? '').id;
  const auth = (c: { req: { header(name: string): string|undefined } }) => {
    const credential = d.credentials.verify(bearerToken(c.req.header('Authorization')) ?? '');
    const member = d.memberFor(credential.memberId);
    if (!member) throw new Error('CAPTURE_CREDENTIAL_INVALID');
    return { memberId: member.id, householdId: member.householdId };
  };
  app.post('/capture/v1/request-id', (c) => {
    c.header('Cache-Control', 'no-store');
    try { auth(c); return c.json({ data: { clientCaptureId: randomUUID() } }); }
    catch (value) { return errorResponse(c, value); }
  });
  app.post('/capture/v1/items', async (c) => {
    try {
      const actor = auth(c); // Reject invalid credentials before consuming upload bytes.
      if (d.limiter && !d.limiter.allow(`capture:${credentialId(c)}`)) throw new Error('CAPTURE_RATE_LIMITED');
      const input = await captureInput(c.req.raw);
      if (c.req.header('Idempotency-Key') !== input.clientCaptureId) throw new Error('IDEMPOTENCY_REQUIRED');
      const payload = input.url ? { ...input, url: validateCaptureUrl(input.url) } : input;
      const guard = () => {
        const current = auth(c);
        if (current.memberId !== actor.memberId || current.householdId !== actor.householdId) throw new Error('CAPTURE_CREDENTIAL_INVALID');
      };
      guard();
      return c.json({ data: await d.captures.create(actor, payload, guard) }, 202);
    } catch (value) { return errorResponse(c, value); }
  });
  app.get('/capture/v1/items/:id', (c) => {
    try { return c.json({ data: d.captures.status(auth(c), c.req.param('id')) }); }
    catch (value) { return errorResponse(c, value); }
  });
}
export function registerCaptureCredentialRoutes(app: Hono<{ Variables: Variables }>, d: D) { const actor = (c: { get: (key: 'identity'|'session') => unknown }) => { const identity = c.get('identity') as { subject: string }; const session = c.get('session') as { member: MemberRecord }; const member = d.memberFor(identity.subject); if (!member || member.id !== session.member.id) throw new Error('UNAUTHENTICATED'); return { memberId: member.id, householdId: member.householdId }; }; app.get('/dashboard/api/v1/capture-credentials', (c) => { try { return c.json({ data: { credentials: d.credentials.list(actor(c)) } }); } catch (value) { return errorResponse(c, value); } }); app.post('/dashboard/api/v1/capture-credentials', async (c) => { try { const input = z.object({ label: z.string().min(1).max(80) }).strict().parse(await c.req.json()); return c.json({ data: d.credentials.create(actor(c), input.label, c.get('nativeSessionId')) }, 201); } catch (value) { return errorResponse(c, value); } }); app.delete('/dashboard/api/v1/capture-credentials/:id', (c) => { try { return c.json({ data: d.credentials.revoke(actor(c), c.req.param('id')) }); } catch (value) { return errorResponse(c, value); } }); }
