import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { backupDir, dailyBackup } from './backups.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('makes one backup a day and keeps the newest few', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fridgedoor-backups-')); dirs.push(root);
  const db = new Database(join(root, 'fridgedoor.sqlite'));
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('hello')");
  const dir = join(root, 'backups');
  for (let day = 1; day <= 5; day++) await dailyBackup(db, dir, 3, new Date(`2026-10-0${day}T03:00:00Z`));
  expect(await dailyBackup(db, dir, 3, new Date('2026-10-05T20:00:00Z'))).toBeUndefined();
  expect(readdirSync(dir).sort()).toEqual(['fridgedoor-2026-10-03.sqlite', 'fridgedoor-2026-10-04.sqlite', 'fridgedoor-2026-10-05.sqlite']);
  const copy = new Database(join(dir, 'fridgedoor-2026-10-05.sqlite'), { readonly: true });
  expect(copy.prepare('SELECT v FROM t').get()).toEqual({ v: 'hello' });
  copy.close(); db.close();
});

it('can be turned off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fridgedoor-backups-')); dirs.push(root);
  const db = new Database(':memory:');
  expect(await dailyBackup(db, join(root, 'backups'), 0)).toBeUndefined();
  expect(readdirSync(root)).toEqual([]);
});

it('keeps backups beside the database, wherever DATABASE_PATH puts it', () => {
  expect(backupDir({ DATABASE_PATH: '/data/fridgedoor.sqlite' })).toBe('/data/backups');
  expect(backupDir({ DATABASE_PATH: '/srv/db/household.sqlite' })).toBe('/srv/db/backups');
});
