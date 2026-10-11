import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AccountService } from './auth/accounts.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { prepareRuntime, setupLink } from './runtime.js';
import { SettingsStore } from './settings.js';

// Admin commands for the server's own shell, e.g. `docker compose exec fridgedoor fridgedoor setup-link`.
const usage = `Usage: fridgedoor <command>

  setup-link              Print the one-time link that creates the first household.
  reset-password <email>  Set a new random password for an account and print it.
  public-url <url>        Change the address people use to reach this server.
  backup [path]           Write a consistent copy of the database (default: <data dir>/backups/).
  members                 List members and their sign-in emails.
  add-login <member-id> <email> [owner|member]
                          Give an existing member a password sign-in and print the password.`;

const [command, arg, arg2, arg3] = process.argv.slice(2);
const config = loadConfig();
mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
const db = new Database(config.DATABASE_PATH);
migrate(db);
const settings = new SettingsStore(db, config.SESSION_SECRET);
const accounts = new AccountService(db);
prepareRuntime(config, settings, accounts.setupRequired());

if (command === 'setup-link') {
  console.log(accounts.setupRequired() ? setupLink(config, settings) : 'Setup is already done. Sign in at ' + `${config.APP_ORIGIN}/dashboard/`);
} else if (command === 'reset-password' && arg) {
  const memberId = accounts.memberIdForEmail(arg);
  if (!memberId) { console.error(`No account uses ${arg}.`); process.exitCode = 1; }
  else { const password = randomBytes(9).toString('base64url'); await accounts.setPassword(memberId, password); console.log(`New password for ${arg}: ${password}\nSign in and change it under Settings → Account.`); }
} else if (command === 'public-url' && arg) {
  const origin = new URL(arg).origin;
  settings.set('public_url', origin);
  console.log(`Public address set to ${origin}. Restart the server for it to take effect${config.ORIGIN_FROM_ENV ? ' (PUBLIC_URL in the environment still overrides it)' : ''}.`);
} else if (command === 'backup') {
  const target = arg ?? join(config.DATA_DIR ?? dirname(config.DATABASE_PATH), 'backups', `fridgedoor-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  mkdirSync(dirname(target), { recursive: true });
  await db.backup(target);
  console.log(`Saved ${target}\nKeep it together with secret.key from the data directory: stored passwords for email and AI keys can't be read without it.`);
} else if (command === 'members') {
  for (const member of accounts.listMembers()) console.log([member.id, member.displayName, member.email ?? '(no password sign-in)', member.role ?? '', member.active ? 'active' : 'removed'].join('  '));
} else if (command === 'add-login' && arg && arg2) {
  const password = randomBytes(9).toString('base64url');
  try { await accounts.addLogin(arg, arg2, password, arg3 === 'member' ? 'member' : 'owner'); console.log(`Password for ${arg2.toLowerCase()}: ${password}\nSign in and change it under Settings → Account.`); }
  catch (error) { console.error(error instanceof Error ? error.message : 'FAILED'); process.exitCode = 1; }
} else {
  console.log(usage);
  if (command) process.exitCode = 1;
}
db.close();
