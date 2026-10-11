import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptJson, keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { GOOGLE_SCOPES, type GoogleGrant } from '../providers/google.js';
import { GoogleTokenService } from './google-tokens.js';

const key = keyFromSecret('synthetic-token-test');
const expired: GoogleGrant = { sub: 'google-owner', email: 'owner@example.test', scopes: [...GOOGLE_SCOPES],
  accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: '2020-01-01T00:00:00Z' };
describe('durable Google refresh', () => {
  let dir: string; let db: Database.Database; let other: Database.Database; let now: Date;
  const fresh = () => ({ ...expired, accessToken: 'fresh-access', refreshToken: 'rotated-refresh', expiresAt: new Date(now.getTime() + 3600000).toISOString() });
  beforeEach(() => {
    now = new Date('2026-01-01T00:00:00Z'); dir = mkdtempSync(join(tmpdir(), 'planner-refresh-'));
    db = new Database(join(dir, 'test.sqlite')); migrate(db);
    other = new Database(join(dir, 'test.sqlite')); migrate(other);
    db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString());
    db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run('m1', 'h1', 'subject', 'Owner', 'UTC', now.toISOString());
    db.prepare(`INSERT INTO google_connections (id, member_id, google_sub, email, grants_json, encrypted_tokens, status,
      generation, disclosure_version, consented_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, 'v1', ?, ?, ?)`)
      .run('c1', 'm1', expired.sub, expired.email, JSON.stringify(expired.scopes), JSON.stringify(encryptJson(expired, key, 'google-connection:c1')),
        now.toISOString(), now.toISOString(), now.toISOString());
  });
  afterEach(() => { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const row = () => db.prepare('SELECT status, generation, encrypted_tokens FROM google_connections WHERE id = ?').get('c1');
  it('persists encrypted rotation and another database connection reuses it without refreshing', async () => {
    const refresh = vi.fn().mockResolvedValue(fresh());
    await new GoogleTokenService(db, key, { refresh }, () => now).grant('c1', 1);
    expect(JSON.stringify(row())).not.toContain('rotated-refresh');
    expect(await new GoogleTokenService(other, key, { refresh }, () => now).grant('c1', 1)).toEqual(fresh());
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('allows only one refresh across independent database handles', async () => {
    let finish!: (grant: GoogleGrant) => void;
    const refresh = vi.fn(() => new Promise<GoogleGrant>((resolve) => { finish = resolve; }));
    const pending = new GoogleTokenService(db, key, { refresh }, () => now).grant('c1', 1);
    await expect(new GoogleTokenService(other, key, { refresh }, () => now).grant('c1', 1)).rejects.toThrow('GOOGLE_REFRESH_BUSY');
    finish(fresh()); await pending;
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it.each(['disconnect', 'disable', 'reconnect', 'delete'] as const)('cannot restore access after concurrent %s', async (action) => {
    const original = row() as { encrypted_tokens: string };
    const refresh = vi.fn(async () => {
      if (action === 'disconnect') other.prepare("UPDATE google_connections SET status = 'disconnected', generation = generation + 1").run();
      if (action === 'disable') other.prepare('UPDATE members SET active = 0').run();
      if (action === 'reconnect') other.prepare('UPDATE google_connections SET generation = generation + 1').run();
      if (action === 'delete') other.prepare('DELETE FROM google_connections').run();
      return fresh();
    });
    await expect(new GoogleTokenService(db, key, { refresh }, () => now).grant('c1', 1)).rejects.toThrow('GOOGLE_CONNECTION_CHANGED');
    if (action === 'delete') expect(row()).toBeUndefined();
    else expect(row()).toMatchObject({ encrypted_tokens: original.encrypted_tokens });
    expect(db.prepare('SELECT count(*) AS count FROM google_refresh_leases').get()).toEqual({ count: 0 });
  });
  it('rejects disabled members before any provider request', async () => {
    other.prepare('UPDATE members SET active = 0').run(); const refresh = vi.fn();
    await expect(new GoogleTokenService(db, key, { refresh }, () => now).grant('c1', 1)).rejects.toThrow('GOOGLE_CONNECTION_INACTIVE');
    expect(refresh).not.toHaveBeenCalled();
  });
  it('invalidates work generation on revoked consent but retains it for transient failures', async () => {
    const transient = vi.fn().mockRejectedValue(new Error('GOOGLE_REFRESH_FAILED'));
    await expect(new GoogleTokenService(db, key, { refresh: transient }, () => now).grant('c1', 1)).rejects.toThrow('GOOGLE_REFRESH_FAILED');
    expect(row()).toMatchObject({ status: 'active', generation: 1 });
    const revoked = vi.fn().mockRejectedValue(new Error('GOOGLE_REAUTH_REQUIRED'));
    await expect(new GoogleTokenService(db, key, { refresh: revoked }, () => now).grant('c1', 1)).rejects.toThrow('GOOGLE_REAUTH_REQUIRED');
    expect(row()).toMatchObject({ status: 'needs_reauth', generation: 2 });
  });
  it('recovers an expired lease and rejects the old lease holder result', async () => {
    let finish!: (grant: GoogleGrant) => void;
    const pending = new GoogleTokenService(db, key, { refresh: () => new Promise((resolve) => { finish = resolve; }) }, () => now).grant('c1', 1);
    now = new Date(now.getTime() + 61000);
    await new GoogleTokenService(other, key, { refresh: async () => fresh() }, () => now).grant('c1', 1);
    finish({ ...fresh(), accessToken: 'late-stale-access' });
    await expect(pending).rejects.toThrow('GOOGLE_CONNECTION_CHANGED');
    expect(await new GoogleTokenService(db, key, { refresh: vi.fn() }, () => now).grant('c1', 1)).toEqual(fresh());
  });
});
