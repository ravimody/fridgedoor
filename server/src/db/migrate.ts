import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';

export function migrate(db: Database.Database) {
  db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
  for (const name of readdirSync(dir).filter((entry) => /^\d+_.+\.sql$/.test(entry)).sort()) {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name)) continue;
    db.transaction(() => { db.exec(readFileSync(join(dir, name), 'utf8')); db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString()); })();
  }
}
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) { const config = loadConfig(); mkdirSync(dirname(config.DATABASE_PATH), { recursive: true }); migrate(new Database(config.DATABASE_PATH)); }
