import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeAccessSubject } from './auth/access-migration.js';
import { createAccessVerifier } from './auth/access.js';
import { AccountService } from './auth/accounts.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createWorker } from './jobs/worker.js';
import { startDailyBackups } from './ops/backups.js';
import { createGoogleProvider } from './providers/google.js';
import { prepareRuntime, setupLink } from './runtime.js';
import { SettingsStore } from './settings.js';

// One process runs the web server and the background worker (FRIDGEDOOR_ROLE=all, the
// default). Larger installs can split them with FRIDGEDOOR_ROLE=api and =worker.
const config = loadConfig();
mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
const db = new Database(config.DATABASE_PATH);
migrate(db);
const settings = new SettingsStore(db, config.SESSION_SECRET);
const accounts = new AccountService(db);
prepareRuntime(config, settings, accounts.setupRequired());
const role = config.FRIDGEDOOR_ROLE ?? 'all';

if (role !== 'worker') {
  const google = createGoogleProvider(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET);
  const verifier = createAccessVerifier(config);
  const verifyAccess = verifier && (async (token: string) => { const identity = await verifier(token); if (identity && config.ACCESS_SUBJECT_MODE === 'email') observeAccessSubject(db, identity); return identity; });
  const builtWeb = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  const webDist = process.env.WEB_DIST ?? (existsSync(builtWeb) ? builtWeb : undefined);
  const app = createApp({ config, db, verifyAccess, google, ...(webDist ? { webDist } : {}) });
  const port = config.PORT ?? 8080;
  const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' });
  console.log(`Fridgedoor is listening on port ${port} (public address ${config.APP_ORIGIN}).`);
  if (accounts.setupRequired()) console.log(`\nFridgedoor isn't set up yet. Open this link to create your household:\n\n  ${setupLink(config, settings)}\n\nIf that isn't the address you use to reach this server, keep everything from /dashboard onward and put your own address in front.\n`);
  const stop = () => { server.close(); db.close(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

if (role !== 'api') { createWorker(config).start(); startDailyBackups(db, join(dirname(config.DATABASE_PATH), 'backups'), config.BACKUP_KEEP ?? 7); }
