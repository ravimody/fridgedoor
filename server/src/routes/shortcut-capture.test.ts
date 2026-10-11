import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { migrate } from '../db/migrate.js';
import { CaptureCredentialService } from '../auth/capture.js';
import { CaptureService } from '../services/captures.js';
import { AssistantService } from '../ai/assistant-service.js';
import { JobQueue } from '../jobs/queue.js';
import { keyFromSecret } from '../crypto.js';

function setup() {
  const db = new Database(':memory:'); migrate(db);
  let now = new Date('2026-09-12T12:00:00Z'); const clock = () => now;
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('house', clock().toISOString());
  db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run('member', 'house', 'different-access-subject', 'Member', 'America/New_York', clock().toISOString());
  const actor = { memberId: 'member', householdId: 'house' };
  let active = true;
  const secret = 'synthetic-session-secret-change-me-1234567890';
  const app = createApp({ db, now: clock, config: { NODE_ENV: 'test', DATABASE_PATH: ':memory:', SESSION_SECRET: secret, APP_ORIGIN: 'https://planner.example.test' }, members: () => [{ id: actor.memberId, householdId: actor.householdId, accessSubject: 'different-access-subject', displayName: 'Member', timezone: 'America/New_York', active }], verifyAccess: async () => null });
  const credentials = new CaptureCredentialService(db, clock);
  const token = credentials.create(actor, 'Synthetic phone');
  const queue = new JobQueue(db, clock);
  const assistant = new AssistantService(db, keyFromSecret(secret), true, undefined, clock);
  const send = (text = 'Beans', id = '11111111-1111-4111-8111-111111111111') => app.request('/capture/v1/items', { method: 'POST', headers: { Authorization: `Bearer ${token.token}`, 'Idempotency-Key': id, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientCaptureId: id, text }) });
  return { db, actor, app, token, credentials, assistant, queue, send, clock, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, disable: () => { active = false; db.prepare('UPDATE members SET active = 0').run(); } };
}

describe('Shortcut assistant handoff', () => {
  it('accepts a member-ID token without Access and atomically queues one durable dispatch', async () => {
    const s = setup(); const first = await s.send(); expect(first.status).toBe(202);
    const receipt = await first.json(); expect(await (await s.send()).json()).toEqual(receipt);
    expect((await s.send('Different')).status).toBe(409);
    expect(s.db.prepare('SELECT count(*) AS n FROM captures').get()).toEqual({ n: 1 });
    expect(s.db.prepare('SELECT count(*) AS n FROM jobs WHERE kind = ?').get('capture_dispatch')).toEqual({ n: 1 });
    expect((await s.app.request('/dashboard/api/v1/assistant/runs', { headers: { Authorization: `Bearer ${s.token.token}` } })).status).toBe(401);
    const failed = new CaptureService(s.db, keyFromSecret('test'), s.clock, () => { throw new Error('QUEUE_UNAVAILABLE'); });
    await expect(failed.create(s.actor, { clientCaptureId: 'rollback', text: 'Rollback' })).rejects.toThrow('QUEUE_UNAVAILABLE');
    expect(s.db.prepare('SELECT count(*) AS n FROM captures').get()).toEqual({ n: 1 });
  });

  it('waits for owner consent, resumes, and does not duplicate a run after a lost dispatch receipt', async () => {
    const s = setup(); await s.send();
    s.assistant.dispatchCapture(s.queue.claim(['capture_dispatch'])!);
    expect(s.assistant.list(s.actor)).toEqual([]);
    expect(s.db.prepare('SELECT state, error_code FROM jobs').get()).toEqual({ state: 'retry_wait', error_code: 'ASSISTANT_CONSENT_REQUIRED' });
    s.assistant.consent(s.actor, true); s.advance(300_000);
    const job = s.queue.claim(['capture_dispatch'])!;
    s.assistant.dispatchCapture(job); s.assistant.dispatchCapture(job);
    expect(s.assistant.list(s.actor)).toHaveLength(1);
    expect(s.assistant.list(s.actor)[0]?.captureId).toBeTruthy();
    expect(s.assistant.list(s.actor)[0]?.createdAt).toBe('2026-09-12T12:00:00.000Z');
    expect(s.db.prepare('SELECT count(*) AS n FROM jobs WHERE kind = ?').get('assistant')).toEqual({ n: 1 });
    s.assistant.consent(s.actor, false);
    expect(s.assistant.list(s.actor)[0]?.state).toBe('failed');
    expect(s.queue.claim(['assistant'])).toBeUndefined();
  });

  it('holds a busy assistant and stops expired or disabled-member captures', async () => {
    const s = setup(); s.assistant.consent(s.actor, true);
    for (let i = 0; i < 10; i++) s.assistant.submit(s.actor, `busy-${i}`, 'Synthetic request');
    await s.send(); s.assistant.dispatchCapture(s.queue.claim(['capture_dispatch'])!);
    expect(s.db.prepare('SELECT error_code FROM jobs WHERE kind = ?').get('capture_dispatch')).toEqual({ error_code: 'ASSISTANT_BUSY' });
    s.advance(7 * 86400000); s.assistant.dispatchCapture(s.queue.claim(['capture_dispatch'])!);
    expect(s.db.prepare('SELECT state, error_code FROM jobs WHERE kind = ?').get('capture_dispatch')).toEqual({ state: 'failed', error_code: 'CAPTURE_UNAVAILABLE' });
    await s.send('Second capture', '22222222-2222-4222-8222-222222222222'); s.disable();
    s.assistant.dispatchCapture(s.queue.claim(['capture_dispatch'])!);
    expect((await s.send()).status).toBe(401);
    expect(s.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'capture_dispatch' AND state = 'failed'").get()).toEqual({ n: 2 });
  });

  it('rejects revoked credentials', async () => {
    const s = setup(); s.credentials.revoke(s.actor, s.token.id); expect((await s.send()).status).toBe(401);
    expect(s.db.prepare('SELECT count(*) AS n FROM captures').get()).toEqual({ n: 0 });
  });
});

it('issues fresh capture IDs only to active capture credentials without creating content', async () => {
  const s = setup(); const path = '/capture/v1/request-id';
  expect((await s.app.request(path, { method: 'POST' })).status).toBe(401);
  const headers = { Authorization: `Bearer ${s.token.token}` };
  const response = await s.app.request(path, { method: 'POST', headers });
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  const id = (await response.json()).data.clientCaptureId;
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect((await (await s.app.request(path, { method: 'POST', headers })).json()).data.clientCaptureId).not.toBe(id);
  expect(s.db.prepare('SELECT count(*) AS n FROM captures').get()).toEqual({ n: 0 });
  expect((await s.send('Synthetic shared text', id)).status).toBe(202);
  expect((await s.send('Synthetic shared text', id)).status).toBe(202);
  expect(s.db.prepare('SELECT count(*) AS n FROM captures').get()).toEqual({ n: 1 });
  s.credentials.revoke(s.actor, s.token.id);
  expect((await s.app.request(path, { method: 'POST', headers })).status).toBe(401);
  const disabled = setup(); disabled.disable();
  expect((await disabled.app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${disabled.token.token}` } })).status).toBe(401);
});

it('captures a PDF once and dispatches it only after owner consent', async () => {
  const s = setup(); const id = '33333333-3333-4333-8333-333333333333';
  const send = (extra = false) => {
    const form = new FormData(); form.set('clientCaptureId', id);
    form.set('file', new File(['%PDF-1.7\n/Type /Page\n'], 'synthetic.pdf', { type: 'application/pdf' }));
    if (extra) form.append('file', new File(['extra'], 'extra.pdf'));
    return s.app.request('/capture/v1/items', { method: 'POST', headers: { Authorization: `Bearer ${s.token.token}`, 'Idempotency-Key': id }, body: form });
  };
  expect((await send(true)).status).toBe(422);
  const first = await send(); expect(first.status).toBe(202);
  expect(await (await send()).json()).toEqual(await first.json());
  expect(s.db.prepare('SELECT kind, mime_type, count(*) AS n FROM captures').get()).toEqual({ kind: 'file', mime_type: 'application/pdf', n: 1 });
  s.assistant.dispatchCapture(s.queue.claim(['capture_dispatch'])!);
  expect(s.assistant.list(s.actor)).toEqual([]);
  s.assistant.consent(s.actor, true); s.advance(300_000);
  s.assistant.dispatchCapture(s.queue.claim(['capture_dispatch'])!);
  expect(s.assistant.list(s.actor)).toHaveLength(1);
});

it('bounds actual upload bytes even when Content-Length understates the body', async () => {
  const s = setup();
  const response = await s.app.request('/capture/v1/items', { method: 'POST', headers: { Authorization: `Bearer ${s.token.token}`, 'Content-Length': '1' }, body: new Uint8Array(10 * 1024 * 1024 + 65537) });
  expect(response.status).toBe(413);
  expect(s.db.prepare('SELECT count(*) AS n FROM captures').get()).toEqual({ n: 0 });
});

it('rejects missing files, unsupported bytes and mismatched multipart request IDs', async () => {
  const s = setup(); const id = '44444444-4444-4444-8444-444444444444';
  const form = new FormData(); form.set('clientCaptureId', id);
  const send = (requestId = id) => s.app.request('/capture/v1/items', { method: 'POST', headers: { Authorization: `Bearer ${s.token.token}`, 'Idempotency-Key': requestId }, body: form });
  expect((await send()).status).toBe(422);
  form.set('file', new File(['not an image'], 'synthetic.jpg', { type: 'image/jpeg' }));
  expect((await send('different')).status).toBe(400);
  expect((await send()).status).toBe(400);
  expect(s.db.prepare('SELECT count(*) AS n FROM captures').get()).toEqual({ n: 0 });
});

it('normalizes a shared image and rejects different media under the same request ID', async () => {
  const sharp = (await import('sharp')).default;
  const s = setup(); const id = '55555555-5555-4555-8555-555555555555';
  const bytes = await sharp({ create: { width: 2, height: 1, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
  const send = (content: Uint8Array, type: string) => {
    const form = new FormData(); form.set('clientCaptureId', id);
    form.set('file', new File([new Uint8Array(content)], 'synthetic', { type }));
    return s.app.request('/capture/v1/items', { method: 'POST', headers: { Authorization: `Bearer ${s.token.token}`, 'Idempotency-Key': id }, body: form });
  };
  expect((await send(bytes, 'image/jpeg')).status).toBe(202);
  expect(s.db.prepare('SELECT mime_type FROM captures').get()).toEqual({ mime_type: 'image/png' });
  expect((await send(new TextEncoder().encode('%PDF-1.7\n/Type /Page\n'), 'application/pdf')).status).toBe(409);
  expect(s.db.prepare('SELECT count(*) AS n FROM captures').get()).toEqual({ n: 1 });
});
