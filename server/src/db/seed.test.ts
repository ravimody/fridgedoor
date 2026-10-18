import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('bootstraps a member but preserves revocation and identity across redeployment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fridgedoor-seed-test-'));
  const databasePath = join(dir, 'fridgedoor.sqlite');
  const seed = (subject: string, email: string) => execFileSync(process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./seed.ts', import.meta.url))], {
      env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_PATH: databasePath,
        FRIDGEDOOR_MEMBER_SUBJECT: subject, FRIDGEDOOR_MEMBER_EMAIL: email },
    });
  let db: Database.Database | undefined;
  try {
    seed('original-subject', 'Owner@Example.test');
    db = new Database(databasePath);
    expect(db.prepare('SELECT active, allowed_email, role FROM members').get()).toEqual({ active: 1, allowed_email: 'owner@example.test', role: 'owner' });
    db.prepare("UPDATE members SET active = 0, display_name = 'Edited name', timezone = 'Europe/London'").run();
    const disabled = db.prepare('SELECT * FROM members').get();
    seed('replacement-subject', 'other@example.test');
    expect(db.prepare('SELECT * FROM members').all()).toEqual([disabled]);
    expect(db.prepare('SELECT count(*) AS count FROM households').get()).toEqual({ count: 1 });
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
