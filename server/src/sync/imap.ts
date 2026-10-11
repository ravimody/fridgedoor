import type Database from 'better-sqlite3';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { z } from 'zod';
import { decryptJson, type Envelope } from '../crypto.js';
import type { JobQueue, JobRecord } from '../jobs/queue.js';
import type { SourceEvidence, SourceRepository } from '../repos/sources.js';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_TOTAL_BYTES, normalizeAttachment, supportedAttachment } from './attachments.js';

export const imapCredentialsSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  /** true: TLS from the start (993). false: STARTTLS (143); plain text is refused. */
  secure: z.boolean(),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(500),
  mailbox: z.string().min(1).max(200).default('INBOX'),
}).strict();
export type ImapCredentials = z.infer<typeof imapCredentialsSchema>;

/** Common providers. All of them need an app password rather than the account password. */
export const IMAP_PRESETS = [
  { id: 'gmail', label: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true, help: 'https://myaccount.google.com/apppasswords', note: 'Needs 2-Step Verification, then an app password.' },
  { id: 'icloud', label: 'iCloud Mail', host: 'imap.mail.me.com', port: 993, secure: true, help: 'https://support.apple.com/en-us/102654', note: 'Use an app-specific password from your Apple Account.' },
  { id: 'fastmail', label: 'Fastmail', host: 'imap.fastmail.com', port: 993, secure: true, help: 'https://www.fastmail.help/hc/en-us/articles/360058752854', note: 'Create an app password with IMAP access.' },
  { id: 'yahoo', label: 'Yahoo Mail', host: 'imap.mail.yahoo.com', port: 993, secure: true, help: 'https://help.yahoo.com/kb/SLN15241.html', note: 'Generate an app password in Account Security.' },
  { id: 'zoho', label: 'Zoho Mail', host: 'imap.zoho.com', port: 993, secure: true, help: 'https://www.zoho.com/mail/help/imap-access.html', note: 'Enable IMAP access; use an app-specific password if two-factor sign-in is on.' },
  { id: 'other', label: 'Other (IMAP)', host: '', port: 993, secure: true, help: null, note: 'Your provider’s IMAP server name, usually imap.<your domain>.' },
] as const;

export type FetchedMessage = { uid: number; source: Buffer; internalDate?: Date };
export type MailboxSession = { uidValidity: string; uidNext: number; search(criteria: { sinceDays: number } | { afterUid: number }): Promise<number[]>; fetch(uids: number[]): AsyncIterable<FetchedMessage>; close(): Promise<void> };
export type MailboxReader = { open(credentials: ImapCredentials): Promise<MailboxSession> };

/** Stable error codes; server replies can contain account details, so they never leave this module. */
export function imapErrorCode(error: unknown): string {
  const value = error as { authenticationFailed?: boolean; code?: string; serverResponseCode?: string; message?: string } | undefined;
  if (value?.authenticationFailed || value?.serverResponseCode === 'AUTHENTICATIONFAILED') return 'IMAP_AUTH_FAILED';
  if (value?.serverResponseCode === 'NONEXISTENT' || value?.serverResponseCode === 'TRYCREATE') return 'IMAP_MAILBOX_NOT_FOUND';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(value?.code ?? '')) return 'IMAP_UNREACHABLE';
  if (['ETIMEDOUT', 'ETIMEOUT', 'ECONNRESET', 'EPIPE'].includes(value?.code ?? '') || value?.code === 'NoConnection') return 'IMAP_TIMEOUT';
  if (/certificate|tls|ssl/i.test(value?.code ?? '') || /certificate|self.signed|tls/i.test(value?.message ?? '')) return 'IMAP_TLS_FAILED';
  return 'IMAP_FAILED';
}

/** Read-only IMAP access: the mailbox is opened with EXAMINE and messages are fetched with BODY.PEEK, so nothing is marked read. */
export const imapflowReader: MailboxReader = {
  async open(credentials) {
    const client = new ImapFlow({ host: credentials.host, port: credentials.port, secure: credentials.secure, ...(credentials.secure ? {} : { doSTARTTLS: true }), auth: { user: credentials.username, pass: credentials.password }, logger: false, connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 120_000 });
    client.on('error', () => undefined);
    try {
      await client.connect();
      const mailbox = await client.mailboxOpen(credentials.mailbox, { readOnly: true });
      return {
        uidValidity: String(mailbox.uidValidity), uidNext: Number(mailbox.uidNext ?? 1),
        async search(criteria) {
          const query = 'sinceDays' in criteria ? { since: new Date(Date.now() - criteria.sinceDays * 86_400_000) } : { uid: `${criteria.afterUid + 1}:*` };
          const found = await client.search(query, { uid: true });
          return (Array.isArray(found) ? found : []).filter((uid) => !('afterUid' in criteria) || uid > criteria.afterUid).sort((a, b) => a - b);
        },
        async *fetch(uids) {
          if (!uids.length) return;
          for await (const message of client.fetch(uids.join(','), { uid: true, source: true, internalDate: true }, { uid: true })) {
            if (message.source) yield { uid: message.uid, source: message.source, ...(message.internalDate instanceof Date ? { internalDate: message.internalDate } : {}) };
          }
        },
        async close() { await client.logout().catch(() => client.close()); },
      };
    } catch (error) { client.close(); throw new Error(imapErrorCode(error)); }
  },
};

const stripHtml = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();

/** Turns a raw RFC 822 message into the same evidence shape Gmail produces. */
export async function normalizeImapMessage(message: FetchedMessage, uidValidity: string, mailbox: string): Promise<SourceEvidence> {
  const parsed: ParsedMail = await simpleParser(message.source, { skipImageLinks: true, skipTextToHtml: true });
  const text = (parsed.text?.trim() || (typeof parsed.html === 'string' ? stripHtml(parsed.html) : '')).slice(0, 24_000);
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? parsed.references.split(/\s+/).filter(Boolean) : [];
  const date = parsed.date ?? message.internalDate;
  // Same shape as a Gmail From header: Name <address>.
  const from = parsed.from?.value[0];
  const sender = from?.address ? (from.name ? `${from.name} <${from.address}>` : from.address) : parsed.from?.text;
  const media: NonNullable<SourceEvidence['media']> = [];
  let incomplete = false; let total = 0;
  const attachments = parsed.attachments.filter((attachment) => attachment.contentDisposition !== 'inline' || supportedAttachment(attachment.contentType));
  for (const attachment of attachments) {
    if (!supportedAttachment(attachment.contentType)) { if (attachment.contentDisposition === 'attachment') incomplete = true; continue; }
    if (media.length >= MAX_ATTACHMENT_COUNT || attachment.size > MAX_ATTACHMENT_BYTES || total + attachment.size > MAX_ATTACHMENT_TOTAL_BYTES) { incomplete = true; continue; }
    try { media.push(await normalizeAttachment(attachment.content, attachment.contentType)); total += attachment.size; } catch { incomplete = true; }
  }
  return {
    providerId: `imap:${parsed.messageId ?? `${uidValidity}:${message.uid}`}`,
    ...(parsed.subject ? { subject: parsed.subject } : {}), ...(sender ? { sender } : {}),
    labels: [mailbox], text, ...(date ? { internalDate: date.toISOString() } : {}),
    ...(parsed.messageId ? { messageId: parsed.messageId } : {}), ...(references.length ? { references } : {}),
    attachmentsIncomplete: incomplete, ...(media.length ? { media } : {}),
  };
}

const BACKFILL_DAYS = 30;
const BACKFILL_LIMIT = 200;
const RUN_LIMIT = 50;
type Row = { id: string; member_id: string; household_id: string; encrypted_tokens: string; status: string; generation: number };
export type ImapSyncResult = { state: 'complete' } | { state: 'retry'; delayMs?: number; retryKind: 'continuation' | 'transient' };

/** Polls an IMAP mailbox and stores new inbox messages for the planner to read. The cursor is `<UIDVALIDITY>:<last UID>`. */
export class ImapSync {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly queue: JobQueue, private readonly sources: SourceRepository, private readonly reader: MailboxReader = imapflowReader, private readonly clock: () => Date = () => new Date()) {}

  private connection(job: JobRecord) {
    const payload = job.payload; if (!payload.connectionId || payload.generation === undefined) throw new Error('JOB_PAYLOAD_INVALID');
    const row = this.db.prepare("SELECT g.id, g.member_id, m.household_id, g.encrypted_tokens, g.status, g.generation FROM google_connections g JOIN members m ON m.id = g.member_id WHERE g.id = ? AND g.provider = 'imap' AND m.active = 1").get(payload.connectionId) as Row | undefined;
    return row && row.status === 'active' && row.generation === payload.generation ? row : undefined;
  }

  async run(job: JobRecord): Promise<ImapSyncResult> {
    const row = this.connection(job); if (!row) return { state: 'complete' };
    this.sources.ensureGmailState(row.id, row.generation, 'imap-v1');
    const lease = this.sources.acquireStream(row.id, row.generation, 5 * 60_000); if (!lease) return { state: 'retry', retryKind: 'transient', delayMs: 60_000 };
    let session: MailboxSession | undefined;
    try {
      const credentials = imapCredentialsSchema.parse(decryptJson(JSON.parse(row.encrypted_tokens) as Envelope, this.key, `imap-connection:${row.id}`));
      session = await this.reader.open(credentials);
      const state = this.sources.getGmailState(row.id)!;
      const [validity, last] = state.cursor?.split(':') ?? [];
      const fresh = !state.cursor || validity !== session.uidValidity;
      const pending = fresh ? (await session.search({ sinceDays: BACKFILL_DAYS })).slice(-BACKFILL_LIMIT) : await session.search({ afterUid: Number(last) });
      const batch = pending.slice(0, RUN_LIMIT);
      let cursor = fresh ? (batch.length ? Math.min(...batch) - 1 : 0) : Number(last);
      for await (const message of session.fetch(batch)) {
        if (!this.connection(job)) return { state: 'complete' };
        const evidence = await normalizeImapMessage(message, session.uidValidity, credentials.mailbox);
        this.sources.persistMessage({ memberId: row.member_id, householdId: row.household_id, connectionId: row.id, generation: row.generation, message: evidence, queue: this.queue });
        cursor = Math.max(cursor, message.uid);
      }
      // Nothing recent: start from the newest message instead of reading the whole mailbox later.
      if (fresh && !batch.length) cursor = Math.max(0, session.uidNext - 1);
      this.sources.complete(row.id, `${session.uidValidity}:${Math.max(cursor, batch.at(-1) ?? cursor)}`, row.generation);
      return pending.length > batch.length ? { state: 'retry', retryKind: 'continuation', delayMs: 1_000 } : { state: 'complete' };
    } catch (error) {
      const code = error instanceof Error && /^IMAP_[A-Z_]+$/.test(error.message) ? error.message : imapErrorCode(error);
      if (!this.connection(job)) return { state: 'complete' };
      if (code === 'IMAP_AUTH_FAILED') {
        // A changed or revoked app password needs the person, not retries.
        this.db.prepare("UPDATE google_connections SET status = 'needs_reauth', generation = generation + 1, revision = revision + 1, updated_at = ? WHERE id = ? AND generation = ?").run(this.clock().toISOString(), row.id, row.generation);
        this.queue.cancelScope(row.id, 'NEEDS_REAUTH'); this.sources.markError(row.id, code); return { state: 'complete' };
      }
      this.sources.markError(row.id, code);
      return { state: 'retry', retryKind: 'transient', delayMs: Math.min(30 * 60_000, Math.max(60_000, 2 ** Math.min(job.attemptCount, 6) * 1000)) };
    } finally {
      await session?.close().catch(() => undefined);
      this.sources.releaseStream(row.id, lease);
    }
  }
}

/** Routes the shared `gmail_sync` job to the right reader for the connection. */
export class MailSync {
  constructor(private readonly db: Database.Database, private readonly gmail: { run(job: JobRecord): Promise<ImapSyncResult> }, private readonly imap: { run(job: JobRecord): Promise<ImapSyncResult> }) {}
  run(job: JobRecord) {
    const provider = (this.db.prepare('SELECT provider FROM google_connections WHERE id = ?').get(job.payload.connectionId) as { provider: string } | undefined)?.provider;
    return provider === 'imap' ? this.imap.run(job) : this.gmail.run(job);
  }
}
