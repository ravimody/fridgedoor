import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { errorHandler } from './errors.js';

const config = { NODE_ENV: 'test' as const, DATABASE_PATH: ':memory:', SESSION_SECRET: 'test-session-secret-change-me-1234567890', APP_ORIGIN: 'https://fridgedoor.example.test' };
const shape = { error: { code: expect.any(String), message: expect.any(String), requestId: expect.any(String) } };
afterEach(() => { vi.restoreAllMocks(); });

describe('shared error handler', () => {
  const app = () => {
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use('*', async (c, next) => { c.set('requestId', 'req-1'); await next(); });
    app.onError(errorHandler({ NOT_FOUND: 404 }));
    app.get('/coded', () => { throw new Error('NOT_FOUND'); });
    app.get('/other-code', () => { throw new Error('STALE_REVISION'); });
    app.get('/validation', () => { z.object({ a: z.string() }).parse({}); return new Response(); });
    app.get('/bug', () => { const value = undefined as unknown as { secret: string }; return new Response(value.secret); });
    return app;
  };

  it('keeps coded errors and their status', async () => {
    const response = await app().request('/coded');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'not found', requestId: 'req-1' } });
    expect((await app().request('/other-code')).status).toBe(400);
    expect(await (await app().request('/validation')).json()).toMatchObject({ error: { code: 'VALIDATION' } });
  });

  it('turns a bug into a logged 500 without leaking details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await app().request('/bug?token=secret-value');
    expect(response.status).toBe(500);
    const body = await response.json() as { error: { code: string; message: string; requestId: string } };
    expect(body).toMatchObject({ error: { code: 'INTERNAL', requestId: 'req-1' } });
    expect(body.error.message).not.toMatch(/undefined|secret/);
    const logged = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, string>;
    expect(logged).toMatchObject({ level: 'error', code: 'INTERNAL', requestId: 'req-1', method: 'GET', route: '/bug' });
    expect(logged.stack).toContain('TypeError');
    expect(JSON.stringify(logged)).not.toContain('secret-value');
  });
});

describe('request limits and ids', () => {
  const app = () => { const db = new Database(':memory:'); migrate(db); return createApp({ db, config }); };
  const big = JSON.stringify({ email: 'a@example.test', password: 'x'.repeat(300 * 1024) });

  it.each(['/dashboard/api/v1/auth/login', '/dashboard/api/v1/auth/setup', '/dashboard/api/v1/auth/invites/some-token', '/native/v1/auth/token', '/dashboard/api/v1/plans'])('refuses an oversized body on %s', async (path) => {
    const response = await app().request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: config.APP_ORIGIN }, body: big });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { ...shape.error, code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('counts the bytes of a body sent without Content-Length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 5; i++) controller.enqueue(chunk); controller.close(); } });
    const response = await app().request('/dashboard/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: config.APP_ORIGIN }, body, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(413);
  });

  it('gives uploads their own, larger limit', async () => {
    const medium = await app().request('/capture/v1/items', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024) }, body: 'x'.repeat(2 * 1024 * 1024) });
    // Past the general limit, so the credential check answers rather than the size check.
    expect(medium.status).toBe(401);
    const huge = await app().request('/capture/v1/items', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(11 * 1024 * 1024) }, body: 'x' });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ error: { code: 'CAPTURE_TOO_LARGE' } });
    const audio = await app().request('/dashboard/api/v1/assistant/transcribe', { method: 'POST', headers: { 'Content-Length': String(6 * 1024 * 1024) }, body: 'x' });
    expect(audio.status).toBe(413);
    expect(await audio.json()).toMatchObject({ error: { code: 'INVALID_AUDIO' } });
  });

  it('echoes a well-formed request id and replaces anything else', async () => {
    expect((await app().request('/healthz', { headers: { 'X-Request-Id': 'abc-123_DEF' } })).headers.get('X-Request-Id')).toBe('abc-123_DEF');
    const replaced = (await app().request('/healthz', { headers: { 'X-Request-Id': '<script>alert(1)</script>' } })).headers.get('X-Request-Id');
    expect(replaced).toMatch(/^[0-9a-f-]{36}$/);
    expect((await app().request('/healthz', { headers: { 'X-Request-Id': 'a'.repeat(65) } })).headers.get('X-Request-Id')).not.toBe('a'.repeat(65));
  });
});
