import type Database from 'better-sqlite3';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PATTERN = /^fridgedoor-(\d{4}-\d{2}-\d{2})\.sqlite$/;

/**
 * Keeps one consistent database copy per day in `<data dir>/backups`, newest `keep` days.
 * Backups sit next to the data, so they protect against mistakes and corruption, not a
 * lost disk; copy them (with secret.key) somewhere else for that.
 */
export async function dailyBackup(db: Database.Database, dir: string, keep: number, now: Date = new Date()) {
  if (keep <= 0) return undefined;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const day = now.toISOString().slice(0, 10);
  const existing = readdirSync(dir).filter((name) => PATTERN.test(name)).sort();
  let created: string | undefined;
  if (!existing.includes(`fridgedoor-${day}.sqlite`)) {
    created = join(dir, `fridgedoor-${day}.sqlite`);
    await db.backup(`${created}.partial`);
    rmSync(created, { force: true });
    renameSync(`${created}.partial`, created);
    existing.push(`fridgedoor-${day}.sqlite`); existing.sort();
  }
  for (const old of existing.slice(0, Math.max(0, existing.length - keep))) rmSync(join(dir, old), { force: true });
  return created;
}

/** Checks hourly and makes the day's backup once; failures are logged as a code and retried next hour. */
export function startDailyBackups(db: Database.Database, dir: string, keep: number) {
  const run = () => { void dailyBackup(db, dir, keep).catch(() => console.error(JSON.stringify({ event: 'backup_failed', code: 'BACKUP_FAILED' }))); };
  setTimeout(run, 60_000).unref();
  return setInterval(run, 60 * 60_000).unref();
}
