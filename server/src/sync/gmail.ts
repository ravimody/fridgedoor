import { isInboxMessage } from './gmail-scope.js';
import type Database from 'better-sqlite3';
import { GoogleTokenService } from '../services/google-tokens.js';
import { JobQueue, type JobRecord } from '../jobs/queue.js';
import { SourceRepository, type SourceEvidence } from '../repos/sources.js';
import type { GmailAttachment, GmailHistoryEvent, GmailMessage, GmailPart, GoogleGrant, GmailProvider, GoogleProvider } from '../providers/google.js';
import { collectAttachmentRefs, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_TOTAL_BYTES, normalizeGmailAttachment } from './attachments.js';

const BACKFILL_QUERY = 'in:inbox newer_than:30d -in:spam -in:trash -is:draft';
const PAGE_SIZE = 100;
const RUN_LIMIT = 200;
const header = (part: GmailPart | undefined, name: string) => part?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value;
const decode = (value: string) => Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8');
const stripHtml = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
function collectParts(part: GmailPart | undefined, text: string[], html: string[], attachments: { incomplete: boolean }) {
  if (!part) return;
  if (part.filename && (part.body?.attachmentId || (part.body?.size ?? 0) > 0)) attachments.incomplete = true;
  const data = part.body?.data;
  if (data && part.mimeType === 'text/plain') text.push(decode(data));
  if (data && part.mimeType === 'text/html') html.push(decode(data));
  for (const child of part.parts ?? []) collectParts(child, text, html, attachments);
}
export function normalizeMessage(message: GmailMessage): SourceEvidence {
  const text: string[] = []; const html: string[] = []; const attachments = { incomplete: false }; collectParts(message.payload, text, html, attachments);
  const body = (text.join('\n').trim() || stripHtml(html.join('\n'))).slice(0, 24_000);
  const subject = header(message.payload, 'Subject'); const sender = header(message.payload, 'From'); const messageId = header(message.payload, 'Message-ID'); const references = header(message.payload, 'References');
  return { providerId: message.id, ...(message.threadId ? { threadId: message.threadId } : {}), ...(subject ? { subject } : {}), ...(sender ? { sender } : {}), labels: message.labelIds ?? [], text: body, ...(message.internalDate ? { internalDate: new Date(Number(message.internalDate)).toISOString() } : {}), ...(messageId ? { messageId } : {}), ...(references ? { references: references.split(/\s+/).filter(Boolean) } : {}), attachmentsIncomplete: attachments.incomplete };
}
export async function normalizeMessageWithAttachments(message: GmailMessage, fetcher: (attachmentId: string) => Promise<GmailAttachment>): Promise<SourceEvidence> {
  const base = normalizeMessage(message);
  const refs: Parameters<typeof collectAttachmentRefs>[1] = [];
  const unsupported = { value: false };
  collectAttachmentRefs(message.payload, refs, unsupported);
  const media: NonNullable<SourceEvidence['media']> = [];
  let incomplete = unsupported.value || refs.length > MAX_ATTACHMENT_COUNT;
  let totalBytes = 0;
  for (const ref of refs.slice(0, MAX_ATTACHMENT_COUNT)) {
    try {
      if ((ref.size ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
      const fetched = ref.attachmentId ? await fetcher(ref.attachmentId) : {};
      if ((fetched.size ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
      const data = ref.inlineData ?? fetched.data;
      if (data) { const encodedBytes = Math.ceil(data.length * 3 / 4); if (totalBytes + encodedBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error('ATTACHMENT_TOTAL_TOO_LARGE'); totalBytes += encodedBytes; }
      media.push(await normalizeGmailAttachment({ declaredMime: ref.mimeType, fetchedData: data }));
    } catch {
      incomplete = true;
    }
  }
  return { ...base, attachmentsIncomplete: incomplete, ...(media.length ? { media } : {}) };
}
const addedIds = (events: GmailHistoryEvent[]) => [...new Set(events.flatMap(event => [...(event.messagesAdded ?? []), ...(event.labelsAdded ?? []).filter(entry => entry.labelIds?.includes('INBOX'))].map(entry => entry.message?.id).filter((id): id is string => Boolean(id))))];
const deletedIds = (events: GmailHistoryEvent[]) => events.flatMap((event) => event.messagesDeleted?.map((entry) => entry.message?.id).filter((id): id is string => Boolean(id)) ?? []);
export type GmailSyncResult = { state: 'complete' } | { state: 'retry'; delayMs?: number; retryKind: 'continuation' | 'transient' };
type ConnectionRow = { id: string; member_id: string; household_id: string; encrypted_tokens: string; status: string; generation: number };

export class GmailSync {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly provider: GmailProvider & Pick<GoogleProvider, 'refresh'>, private readonly queue: JobQueue, private readonly sources: SourceRepository, private readonly clock: () => Date = () => new Date()) {}

  private connection(job: JobRecord) {
    const payload = job.payload; if (!payload.connectionId || payload.generation === undefined) throw new Error('JOB_PAYLOAD_INVALID');
    const row = this.db.prepare('SELECT g.id, g.member_id, m.household_id, g.encrypted_tokens, g.status, g.generation FROM google_connections g JOIN members m ON m.id = g.member_id WHERE g.id = ? AND m.active = 1').get(payload.connectionId) as ConnectionRow | undefined;
    if (!row || row.status !== 'active' || row.generation !== payload.generation) return undefined;
    return row;
  }
  private async request<T>(job: JobRecord, row: ConnectionRow, operation: (grant: GoogleGrant) => Promise<T>): Promise<T> {
    const grant = await new GoogleTokenService(this.db, this.key, this.provider, this.clock).grant(row.id, row.generation);
    if (!this.connection(job)) throw new Error('GOOGLE_CONNECTION_INACTIVE');
    try {
      const result = await operation(grant);
      if (!this.connection(job)) throw new Error('GOOGLE_CONNECTION_INACTIVE');
      return result;
    } catch (error) {
      if (!this.connection(job)) throw new Error('GOOGLE_CONNECTION_INACTIVE');
      throw error;
    }
  }
  private requeue(job: JobRecord, retryKind: 'continuation' | 'transient' = 'transient'): GmailSyncResult { return { state: 'retry', retryKind, delayMs: Math.min(30 * 60_000, Math.max(30_000, 2 ** Math.min(job.attemptCount, 6) * 1000)) }; }
  async run(job: JobRecord): Promise<GmailSyncResult> {
    const row = this.connection(job); if (!row) return { state: 'complete' };
    const state = this.sources.ensureGmailState(row.id, row.generation);
    const streamLease = this.sources.acquireStream(row.id, row.generation); if (!streamLease) return this.requeue(job);
    try {
      if (!state.cursor && !state.initialAnchor) {
        const profile = await this.request(job, row, (grant) => this.provider.getGmailProfile(grant));
        this.sources.setAnchor(row.id, row.generation, profile.historyId);
      }
      const current = this.sources.getGmailState(row.id)!;
      if (!current.cursor && current.queryVersion === 'gmail-v1') {
        const page = await this.request(job, row, (grant) => this.provider.listGmailMessages(grant, { query: BACKFILL_QUERY, ...(current.pageToken ? { pageToken: current.pageToken } : {}), maxResults: PAGE_SIZE }));
        for (const ref of page.items.slice(0, RUN_LIMIT)) {
          try {
            const normalized = await this.request(job, row, async (grant) => {
              const message = await this.provider.getGmailMessage(grant, ref.id);
              if (!isInboxMessage(message)) return undefined;
              return normalizeMessageWithAttachments(message, (attachmentId) => this.provider.getGmailAttachment(grant, ref.id, attachmentId));
            });
            if (normalized) this.sources.persistMessage({ memberId: row.member_id, householdId: row.household_id, connectionId: row.id, generation: row.generation, message: normalized, queue: this.queue });
          } catch (error) { if (error instanceof Error && error.message === 'GOOGLE_MESSAGE_NOT_FOUND') this.sources.markDeleted(row.member_id, row.id, row.generation, ref.id); else throw error; }
        }
        if (page.nextPageToken) { this.sources.setPage(row.id, page.nextPageToken, row.generation); return this.requeue(job, 'continuation'); }
        this.sources.setQueryVersion(row.id, 'gmail-history');
      }
      const historyState = this.sources.getGmailState(row.id)!;
      const startHistoryId = historyState.cursor ?? historyState.initialAnchor;
      if (!startHistoryId) throw new Error('GMAIL_ANCHOR_MISSING');
      const page = await this.request(job, row, (grant) => this.provider.listGmailHistory(grant, { startHistoryId, ...(historyState.pageToken ? { pageToken: historyState.pageToken } : {}) }));
      const refs = addedIds(page.items);
      // Drain every reference in this page before advancing its cursor.
      for (const id of refs) {
        try {
          const normalized = await this.request(job, row, async (grant) => {
            const message = await this.provider.getGmailMessage(grant, id);
            if (!isInboxMessage(message)) return undefined;
            return normalizeMessageWithAttachments(message, (attachmentId) => this.provider.getGmailAttachment(grant, id, attachmentId));
          });
          if (normalized) this.sources.persistMessage({ memberId: row.member_id, householdId: row.household_id, connectionId: row.id, generation: row.generation, message: normalized, queue: this.queue });
        } catch (error) { if (error instanceof Error && error.message === 'GOOGLE_MESSAGE_NOT_FOUND') this.sources.markDeleted(row.member_id, row.id, row.generation, id); else throw error; }
      }
      for (const id of deletedIds(page.items)) this.sources.markDeleted(row.member_id, row.id, row.generation, id);
      if (page.nextPageToken) { this.sources.setPage(row.id, page.nextPageToken, row.generation); return this.requeue(job, 'continuation'); }
      this.sources.complete(row.id, page.historyId ?? startHistoryId, row.generation);
      return { state: 'complete' };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'GMAIL_SYNC_FAILED';
      if (['GOOGLE_CONNECTION_INACTIVE', 'GOOGLE_CONNECTION_CHANGED', 'GOOGLE_REAUTH_REQUIRED'].includes(code) || !this.connection(job)) return { state: 'complete' };
      if (code === 'GOOGLE_REFRESH_BUSY') return this.requeue(job, 'continuation');
      if (code === 'GOOGLE_INVALID_GRANT') { this.db.prepare("UPDATE google_connections SET status = 'needs_reauth', generation = generation + 1, revision = revision + 1, updated_at = ? WHERE id = ? AND generation = ?").run(this.clock().toISOString(), row.id, row.generation); this.queue.cancelScope(row.id, 'NEEDS_REAUTH'); this.sources.markError(row.id, code); return { state: 'complete' }; }
      if (code === 'GOOGLE_HISTORY_EXPIRED') { this.sources.resetCursor(row.id, row.generation); this.sources.markError(row.id, code); return this.requeue(job); }
      this.sources.markError(row.id, ['GOOGLE_RATE_LIMITED', 'GOOGLE_REFRESH_FAILED'].includes(code) ? code : 'GMAIL_SYNC_FAILED'); return this.requeue(job);
    } finally { this.sources.releaseStream(row.id, streamLease); }
  }
}
