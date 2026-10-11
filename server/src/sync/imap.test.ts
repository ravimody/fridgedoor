import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { JobQueue, type JobRecord } from '../jobs/queue.js';
import { FakeGoogleProvider } from '../providers/google.js';
import { SourceRepository } from '../repos/sources.js';
import { assertMailHost, ConnectionService } from '../services/connections.js';
import { ImapSync, normalizeImapMessage, type FetchedMessage, type MailboxReader } from './imap.js';

const key = keyFromSecret('test-session-secret-change-me-1234567890');
const raw = (uid: number, subject: string, extra = '') => ({ uid, source: Buffer.from([
  'From: Brookside PTA <pta@brookside.example.org>', 'To: alex@example.test', `Subject: ${subject}`, `Message-ID: <msg-${uid}@example.org>`,
  'References: <root@example.org> <parent@example.org>', 'Date: Fri, 09 Oct 2026 14:00:00 +0000', 'MIME-Version: 1.0', extra || 'Content-Type: text/plain; charset=utf-8', '', `Body of ${subject}`, '',
].join('\r\n')) }) satisfies FetchedMessage;

class FakeMailbox implements MailboxReader {
  messages: FetchedMessage[] = []; uidValidity = '7'; opened = 0; failWith: string | undefined;
  async open() {
    if (this.failWith) throw new Error(this.failWith);
    this.opened += 1; const messages = this.messages;
    return {
      uidValidity: this.uidValidity, uidNext: Math.max(0, ...messages.map((m) => m.uid)) + 1,
      async search(criteria: { sinceDays: number } | { afterUid: number }) { return messages.map((m) => m.uid).filter((uid) => !('afterUid' in criteria) || uid > criteria.afterUid); },
      async *fetch(uids: number[]) { for (const message of messages) if (uids.includes(message.uid)) yield message; },
      async close() { /* nothing to close */ },
    };
  }
}

function setup() {
  const db = new Database(':memory:'); migrate(db); const now = new Date().toISOString();
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now);
  db.prepare("INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES ('m1', 'h1', 'local:m1', 'Alex', 'UTC', 1, ?)").run(now);
  const mailbox = new FakeMailbox(); const queue = new JobQueue(db); const sources = new SourceRepository(db, key);
  const connections = new ConnectionService(db, key, new FakeGoogleProvider(), 'https://fridgedoor.example.test', () => new Date(), mailbox);
  const member = { id: 'm1', householdId: 'h1', accessSubject: 'local:m1', displayName: 'Alex', timezone: 'UTC', active: true };
  return { db, mailbox, queue, sources, connections, member, sync: new ImapSync(db, key, queue, sources, mailbox) };
}
const credentials = { host: 'imap.example.test', port: 993, secure: true, username: 'alex@example.test', password: 'app-password', mailbox: 'INBOX' };
const job = (db: Database.Database): JobRecord => { const row = db.prepare('SELECT id, generation FROM google_connections').get() as { id: string; generation: number }; return { id: 'j', kind: 'gmail_sync', scopeId: row.id, payload: { connectionId: row.id, generation: row.generation }, attemptCount: 0 } as unknown as JobRecord; };
const stored = (db: Database.Database) => (db.prepare("SELECT count(*) AS n FROM source_items WHERE kind = 'gmail_message'").get() as { n: number }).n;

describe('IMAP email', () => {
  it('normalizes a message like Gmail evidence', async () => {
    const evidence = await normalizeImapMessage(raw(3, 'Picture day'), '7', 'INBOX');
    expect(evidence).toMatchObject({ providerId: 'imap:<msg-3@example.org>', subject: 'Picture day', sender: 'Brookside PTA <pta@brookside.example.org>', labels: ['INBOX'], text: 'Body of Picture day', messageId: '<msg-3@example.org>', references: ['<root@example.org>', '<parent@example.org>'], attachmentsIncomplete: false });
    const html = await normalizeImapMessage({ uid: 4, source: Buffer.from('Subject: Hi\r\nContent-Type: text/html\r\n\r\n<p>Bake <b>sale</b> Friday</p><script>x()</script>') }, '7', 'INBOX');
    expect(html.text).toBe('Bake sale Friday');
    expect(html.providerId).toBe('imap:7:4');
  });

  it('checks the password before saving, then backfills and follows new mail without re-reading', async () => {
    const ctx = setup();
    ctx.mailbox.failWith = 'IMAP_AUTH_FAILED';
    await expect(ctx.connections.connectImap(ctx.member, { email: 'alex@example.test', credentials, disclosureVersion: 'v1' })).rejects.toThrow('IMAP_AUTH_FAILED');
    expect(ctx.db.prepare('SELECT count(*) AS n FROM google_connections').get()).toEqual({ n: 0 });
    ctx.mailbox.failWith = undefined;
    ctx.mailbox.messages = [raw(10, 'Soccer practice'), raw(11, 'Book fair')];
    const status = await ctx.connections.connectImap(ctx.member, { email: 'Alex@Example.test', credentials, disclosureVersion: 'v1' });
    expect(status).toMatchObject({ connected: true, provider: 'imap', email: 'alex@example.test', status: 'active' });
    const stored0 = ctx.db.prepare('SELECT encrypted_tokens FROM google_connections').get() as { encrypted_tokens: string };
    expect(stored0.encrypted_tokens).not.toContain('app-password');

    expect(await ctx.sync.run(job(ctx.db))).toEqual({ state: 'complete' });
    expect(stored(ctx.db)).toBe(2);
    expect(ctx.sources.getGmailState((ctx.db.prepare('SELECT id FROM google_connections').get() as { id: string }).id)?.cursor).toBe('7:11');
    ctx.mailbox.messages.push(raw(12, 'Dentist reminder'));
    await ctx.sync.run(job(ctx.db));
    expect(stored(ctx.db)).toBe(3);
    await ctx.sync.run(job(ctx.db));
    expect(stored(ctx.db)).toBe(3);
  });

  it('starts over when the server resets UIDs and pauses on a rejected password', async () => {
    const ctx = setup();
    ctx.mailbox.messages = [raw(1, 'One')];
    await ctx.connections.connectImap(ctx.member, { email: 'alex@example.test', credentials, disclosureVersion: 'v1' });
    await ctx.sync.run(job(ctx.db));
    ctx.mailbox.uidValidity = '8'; ctx.mailbox.messages = [raw(1, 'One again'), raw(2, 'Two')];
    await ctx.sync.run(job(ctx.db));
    const connectionId = (ctx.db.prepare('SELECT id FROM google_connections').get() as { id: string }).id;
    expect(ctx.sources.getGmailState(connectionId)?.cursor).toBe('8:2');
    ctx.mailbox.failWith = 'IMAP_AUTH_FAILED';
    expect(await ctx.sync.run(job(ctx.db))).toEqual({ state: 'complete' });
    expect(ctx.connections.status('m1')).toMatchObject({ status: 'needs_reauth', syncErrorCode: 'IMAP_AUTH_FAILED' });
  });

  it('does not let an IMAP mailbox replace an active Gmail connection', async () => {
    const ctx = setup(); const now = new Date().toISOString();
    ctx.db.prepare("INSERT INTO google_connections (id, member_id, google_sub, email, grants_json, encrypted_tokens, status, generation, disclosure_version, consented_at, revision, created_at, updated_at) VALUES ('g1', 'm1', 'sub', 'alex@example.test', '[]', '{}', 'active', 1, 'v1', ?, 1, ?, ?)").run(now, now, now);
    await expect(ctx.connections.connectImap(ctx.member, { email: 'alex@example.test', credentials, disclosureVersion: 'v1' })).rejects.toThrow('CONNECTION_EXISTS');
  });

  it('refuses this machine and link-local addresses but allows home-network servers', async () => {
    for (const host of ['127.0.0.1', '169.254.169.254', '::1', '0.0.0.0']) await expect(assertMailHost(host)).rejects.toThrow('IMAP_HOST_NOT_ALLOWED');
    await expect(assertMailHost('mail.example.test', async () => ['127.0.0.1'])).rejects.toThrow('IMAP_HOST_NOT_ALLOWED');
    for (const host of ['10.0.0.5', '192.168.1.20', 'host.docker.internal']) await expect(assertMailHost(host)).resolves.toBeUndefined();
  });

  it('forgets the app password when the mailbox is disconnected', async () => {
    const ctx = setup();
    const status = await ctx.connections.connectImap(ctx.member, { email: 'alex@example.test', credentials, disclosureVersion: 'v1' });
    await ctx.connections.transition('m1', 'disconnect', status.revision);
    expect(ctx.db.prepare('SELECT status, encrypted_tokens FROM google_connections').get()).toEqual({ status: 'disconnected', encrypted_tokens: '' });
  });
});
