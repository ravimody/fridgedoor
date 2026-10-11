import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
it('permits the public worker to control only dashboard scope while keeping browser APIs authenticated', async () => {
  const webDist = mkdtempSync(join(tmpdir(), 'planner-pwa-'));
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
    expect(worker.headers.get('Content-Type')).toBe('text/javascript');
    expect(worker.headers.get('Cache-Control')).toBe('no-store');
    expect((await app.request('/dashboard/api/v1/push-subscriptions')).status).toBe(401);
  } finally { db.close(); rmSync(webDist, { recursive: true }); }
});
