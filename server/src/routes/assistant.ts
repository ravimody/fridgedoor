import { assistantResultSchema } from '@fridgedoor/contracts';
import { z, ZodError } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { MAX_AUDIO_BYTES, canTranscribe, transcribe } from '../providers/transcription.js';
import type { LlmHub } from '../llm/hub.js';
import { Hono } from 'hono';
import type { Variables } from '../app.js';
import type { MemberRecord } from '../auth/access.js';
import type { AssistantService } from '../ai/assistant-service.js';
export function registerAssistantRoutes(root: Hono<{ Variables: Variables }>, service: AssistantService, audio?: LlmHub) {
  const app = new Hono<{ Variables: Variables }>();
  const base = '/dashboard/api/v1/assistant';
  app.use(`${base}/*`, async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.onError((error, c) => {
    const code = error instanceof ZodError ? 'VALIDATION' : /^[A-Z_]+$/.test(error.message) ? error.message : 'ASSISTANT_ERROR';
    return c.json({ error: { code, message: code.toLowerCase(), requestId: c.get('requestId') } }, code === 'NOT_FOUND' ? 404 : 400);
  });
  const actor = (session: unknown) => { const m = (session as { member: MemberRecord }).member; return { memberId: m.id, householdId: m.householdId }; };
  const audioUsage = new Map<string, { reset: number; count: number; busy: boolean }>();
  app.post(`${base}/transcribe`, bodyLimit({ maxSize: MAX_AUDIO_BYTES + 65536, onError: (c) => c.json({ error: { code: 'INVALID_AUDIO' } }, 413) }), async (c) => {
    const owner = actor(c.get('session'));
    const allowed = () => { const settings = service.settings(owner); if (!settings.enabled || !settings.consent) throw new Error('ASSISTANT_CONSENT_REQUIRED'); };
    allowed();
    if (!audio || !canTranscribe(audio)) throw new Error('TRANSCRIPTION_UNAVAILABLE');
    const now = Date.now();
    for (const [id, usage] of audioUsage) if (usage.reset <= now && !usage.busy) audioUsage.delete(id);
    const usage = audioUsage.get(owner.memberId) ?? { reset: now + 3600000, count: 0, busy: false };
    if (usage.busy || usage.count >= 30 || audioUsage.size >= 1000 && !audioUsage.has(owner.memberId)) return c.json({ error: { code: 'TRANSCRIPTION_LIMIT' } }, 429);
    usage.busy = true; usage.count++; audioUsage.set(owner.memberId, usage);
    try {
      const file = (await c.req.formData()).get('file');
      if (!(file instanceof File)) throw new Error('INVALID_AUDIO');
      const text = await transcribe(file, audio);
      allowed();
      return c.json({ data: { text } });
    } finally { usage.busy = false; }
  });
  app.post(`${base}/presence`, async (c) => { const input = z.object({ clientId: z.string().uuid(), visible: z.boolean() }).strict().parse(await c.req.json()); service.presence(actor(c.get('session')), input.clientId, input.visible); return c.json({ data: { recorded: true } }); });
  app.get(`${base}/settings`, (c) => c.json({ data: service.settings(actor(c.get('session'))) }));
  app.post(`${base}/settings`, async (c) => { const input = z.object({ enabled: z.boolean() }).strict().parse(await c.req.json()); return c.json({ data: service.consent(actor(c.get('session')), input.enabled) }); });
  app.get(`${base}/runs`, (c) => c.json({ data: service.list(actor(c.get('session'))) }));
  app.post(`${base}/runs`, async (c) => { const input = z.object({ clientId: z.string().min(1).max(100), text: z.string().max(8000), captureId: z.string().min(1).optional() }).strict().parse(await c.req.json()); return c.json({ data: service.submit(actor(c.get('session')), input.clientId, input.text, input.captureId) }, 202); });
  app.post(`${base}/runs/:id/review`, async (c) => { const input = z.object({ target: z.enum(['item', 'knowledge']), index: z.number().int().nonnegative(), choice: z.enum(['save', 'keep', 'calendar', 'dismiss']), edited: assistantResultSchema.shape.items.element.optional() }).strict().parse(await c.req.json()); return c.json({ data: service.review(actor(c.get('session')), c.req.param('id'), input.target, input.index, input.choice, input.edited) }); });
  app.post(`${base}/runs/:id/undo`, async (c) => { const input = z.object({ index: z.number().int().nonnegative() }).strict().parse(await c.req.json()); return c.json({ data: service.undo(actor(c.get('session')), c.req.param('id'), input.index) }); });
  app.post(`${base}/runs/:id/apply`, (c) => c.json({ data: service.apply(actor(c.get('session')), c.req.param('id')) }));
  app.post(`${base}/runs/:id/retry`, (c) => { service.retry(actor(c.get('session')), c.req.param('id')); return c.json({ data: { queued: true } }); });
  app.post(`${base}/runs/:id/feedback`, async (c) => { const input = z.object({ value: z.enum(['helpful', 'needs_work']) }).strict().parse(await c.req.json()); service.feedback(actor(c.get('session')), c.req.param('id'), input.value); return c.json({ data: { saved: true } }); });
  app.delete(`${base}/runs/:id`, (c) => { service.remove(actor(c.get('session')), c.req.param('id')); return c.json({ data: { deleted: true } }); });
  app.post(`${base}/knowledge`, async (c) => { const body = await c.req.json(); if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'expectedRevision')) throw new Error('STALE_CLIENT'); const input = z.object({ key: z.string().min(1).max(80), value: z.string().min(1).max(500), expectedRevision: z.number().int().nonnegative() }).strict().parse(body); return c.json({ data: service.setKnowledge(actor(c.get('session')), input.key, input.value, input.expectedRevision) }); });
  app.get(`${base}/knowledge`, (c) => c.json({ data: service.knowledge(actor(c.get('session'))) }));
  app.get(`${base}/knowledge/history`, (c) => c.json({ data: service.knowledgeHistory(actor(c.get('session'))) }));
  app.post(`${base}/knowledge/history/:id/undo`, async (c) => { const input = z.object({ expectedRevision: z.number().int().nonnegative() }).strict().parse(await c.req.json()); return c.json({ data: service.undoKnowledge(actor(c.get('session')), c.req.param('id'), input.expectedRevision) }); });
  app.delete(`${base}/knowledge/:key`, async (c) => { const body = await c.req.json(); if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'expectedRevision')) throw new Error('STALE_CLIENT'); const input = z.object({ expectedRevision: z.number().int().nonnegative() }).strict().parse(body); return c.json({ data: service.forget(actor(c.get('session')), c.req.param('key'), input.expectedRevision) }); });
  root.route('/', app);
}
