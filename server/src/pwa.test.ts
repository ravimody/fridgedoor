import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
it('permits the public worker to control only dashboard scope while keeping browser APIs authenticated', async () => {
  const webDist = mkdtempSync(join(tmpdir(), 'fridgedoor-pwa-'));
  const db = new Database(':memory:');
  try {
    migrate(db);
    writeFileSync(join(webDist, 'sw.js'), '// synthetic worker');
    mkdirSync(join(webDist, 'assets'));
    writeFileSync(join(webDist, 'assets/app.bin'), Buffer.from([1, 2, 3]));
    const app = createApp({ db, webDist, config: { NODE_ENV: 'test', DATABASE_PATH: ':memory:', SESSION_SECRET: 'synthetic-session-secret-for-pwa-test', APP_ORIGIN: 'https://planner.example.test' }, members: () => [], verifyAccess: async () => null });
    const worker = await app.request('/pwa/sw.js');
    expect(worker.status).toBe(200);
    const asset = await app.request('/pwa/assets/app.bin');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    expect(worker.headers.get('Service-Worker-Allowed')).toBe('/dashboard/');
    expect(worker.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(worker.headers.get('Cache-Control')).toBe('no-store');
    expect((await app.request('/dashboard/api/v1/push-subscriptions')).status).toBe(401);
  } finally { db.close(); rmSync(webDist, { recursive: true }); }
});

it('serves the web app with security headers and correct types', async () => {
  const webDist = mkdtempSync(join(tmpdir(), 'fridgedoor-pwa-'));
  const db = new Database(':memory:');
  try {
    migrate(db);
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><script type="module" src="/pwa/assets/app.js"></script>');
    writeFileSync(join(webDist, 'offline.html'), '<!doctype html><style>body{color:red}</style><p>Offline</p>');
    writeFileSync(join(webDist, 'icon.png'), Buffer.from([137, 80, 78, 71]));
    writeFileSync(join(webDist, 'manifest.webmanifest'), '{}');
    const config = { NODE_ENV: 'test' as const, DATABASE_PATH: ':memory:', SESSION_SECRET: 'synthetic-session-secret-for-pwa-test', APP_ORIGIN: 'https://fridgedoor.example.test', TRUST_PROXY: 'true' as const };
    const app = createApp({ db, webDist, config, members: () => [], verifyAccess: async () => null });
    const page = await app.request('/dashboard/join/some-invite-token', { headers: { 'X-Forwarded-Proto': 'https' } });
    expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'self';");
    expect(page.headers.get('Content-Security-Policy')).toContain("img-src 'self' data:");
    expect(page.headers.get('X-Frame-Options')).toBe('DENY');
    expect(page.headers.get('X-Content-Type-Options')).toBe('nosniff');
    // Invite and setup links carry tokens, so nothing is sent as a referrer.
    expect(page.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(page.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect((await app.request('/dashboard/')).headers.get('Strict-Transport-Security')).toBeNull();
    const offline = await app.request('/pwa/offline.html');
    expect(offline.headers.get('Content-Security-Policy')).toMatch(/style-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    expect((await app.request('/pwa/icon.png')).headers.get('Content-Type')).toBe('image/png');
    expect((await app.request('/pwa/manifest.webmanifest')).headers.get('Content-Type')).toBe('application/manifest+json');
  } finally { db.close(); rmSync(webDist, { recursive: true }); }
});
