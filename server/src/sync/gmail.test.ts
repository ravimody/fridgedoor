import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptJson, keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { JobQueue } from '../jobs/queue.js';
import { SourceRepository } from '../repos/sources.js';
import { FakeGoogleProvider, GOOGLE_SCOPES, type GoogleGrant } from '../providers/google.js';
import { GmailSync, normalizeMessage, normalizeMessageWithAttachments } from './gmail.js';

const grant: GoogleGrant = { sub: 'g1', email: 'alex@example.test', scopes: [...GOOGLE_SCOPES], accessToken: 'a', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z' };
const message = (id: string, text: string) => ({ id, labelIds: ['INBOX'], threadId: `t-${id}`, internalDate: '1767225600000', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: `Subject ${id}` }, { name: 'From', value: 'sender@example.test' }], body: { data: Buffer.from(text).toString('base64url') } } });
describe('Gmail ingestion', () => {
  let db: Database.Database; let now: Date; let queue: JobQueue; let sync: GmailSync;
  beforeEach(() => { db = new Database(':memory:'); migrate(db); now = new Date('2026-01-01T00:00:00.000Z'); db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString()); db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Alex', 'America/New_York', 1, now.toISOString()); db.prepare('INSERT INTO google_connections (id, member_id, google_sub, email, grants_json, encrypted_tokens, status, generation, disclosure_version, consented_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('c1', 'm1', 'g1', grant.email, JSON.stringify(grant.scopes), JSON.stringify(encryptJson(grant, keyFromSecret('secret'), 'google-connection:c1')), 'active', 1, 'v1', now.toISOString(), now.toISOString(), now.toISOString()); queue = new JobQueue(db, () => now, 1000); const sources = new SourceRepository(db, keyFromSecret('secret'), () => now); const provider = new FakeGoogleProvider({ good: grant }, { profile: { historyId: '10' }, pages: { first: { items: [{ id: 'm1' }], nextPageToken: 'p2' }, p2: { items: [{ id: 'm2' }] } }, messages: { m1: message('m1', 'one'), m2: message('m2', 'two') }, history: { '10': { items: [], historyId: '11' } } }); sync = new GmailSync(db, keyFromSecret('secret'), provider, queue, sources, () => now); });
  it('normalizes MIME text and keeps attachment processing incomplete', () => { const value = normalizeMessage({ id: 'm1', payload: { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/html', body: { data: Buffer.from('<p>Hello&nbsp;world</p>').toString('base64url') } }, { filename: 'ticket.pdf', body: { attachmentId: 'a1', size: 10 } }] } }); expect(value.text).toBe('Hello world'); expect(value.attachmentsIncomplete).toBe(true); });
  it('fetches and normalizes supported attachments into private media evidence', async () => { const attachment = Buffer.from('%PDF-1.7\n1 0 obj /Type /Page >> endobj\n%%EOF').toString('base64url'); const value = await normalizeMessageWithAttachments({ id: 'm-media', payload: { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Bring the ticket').toString('base64url') } }, { mimeType: 'application/pdf', filename: 'ticket.pdf', body: { attachmentId: 'a1', size: 40 } }] } }, async (id) => id === 'a1' ? { data: attachment } : {}); expect(value.attachmentsIncomplete).toBe(false); expect(value.media).toHaveLength(1); expect(value.media?.[0]).toMatchObject({ kind: 'pdf', pageCount: 1 }); });
  it('persists each page before advancing and then commits the history cursor', async () => {
    const created = queue.enqueue({ kind: 'gmail_sync', scopeId: 'c1', dedupeKey: 'sync:1', payload: { connectionId: 'c1', generation: 1 } }); const first = queue.claim(['gmail_sync'])!; expect((await sync.run(first)).state).toBe('retry'); expect((db.prepare('SELECT page_token FROM sync_states').get() as { page_token: string }).page_token).toBe('p2'); expect(db.prepare('SELECT COUNT(*) AS count FROM source_versions').get()).toEqual({ count: 1 }); queue.retry(first, 'CONTINUE', new Date(now.getTime() + 1)); now = new Date(now.getTime() + 2); const second = queue.claim(['gmail_sync'])!; expect((await sync.run(second)).state).toBe('complete'); expect(db.prepare('SELECT cursor, page_token FROM sync_states').get()).toEqual({ cursor: '11', page_token: null }); expect(db.prepare('SELECT COUNT(*) AS count FROM source_versions').get()).toEqual({ count: 2 }); expect(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind = 'extract_source'").get()).toEqual({ count: 2 }); expect(created.id).toBe(first.id); });
  it('marks deleted messages unavailable without deleting the source identity', async () => { const sources = new SourceRepository(db, keyFromSecret('secret'), () => now); sources.persistMessage({ memberId: 'm1', householdId: 'h1', connectionId: 'c1', generation: 1, message: normalizeMessage(message('gone', 'old')), queue }); sources.ensureGmailState('c1', 1); db.prepare("UPDATE sync_states SET cursor = '10', query_version = 'gmail-history' WHERE connection_id = 'c1'").run(); const provider = new FakeGoogleProvider({ good: grant }, { history: { '10': { items: [{ messagesDeleted: [{ message: { id: 'gone' } }] }], historyId: '12' } } }); sync = new GmailSync(db, keyFromSecret('secret'), provider, queue, sources, () => now); queue.enqueue({ kind: 'gmail_sync', scopeId: 'c1', dedupeKey: 'sync:delete', payload: { connectionId: 'c1', generation: 1 } }); const job = queue.claim(['gmail_sync'])!; await sync.run(job); expect(db.prepare('SELECT error_code FROM sync_states').get()).toEqual({ error_code: null }); expect((db.prepare('SELECT state FROM source_items').get() as { state: string }).state).toBe('deleted'); expect(db.prepare('SELECT COUNT(*) AS count FROM source_items').get()).toEqual({ count: 1 }); });
  it('scopes backfill to Inbox and filters non-Inbox messages before attachment reads or extraction', async () => {
    const inbox=message('inbox','keep'), archived={...message('archived','skip'),labelIds:[]};
    const provider=new FakeGoogleProvider({}, {messages:{inbox,archived}});
    const list=vi.spyOn(provider,'listGmailMessages');
    await runWith(provider);
    expect(list).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({query:'in:inbox newer_than:30d -in:spam -in:trash -is:draft'}));
    expect(db.prepare('SELECT count(*) n FROM source_items').get()).toEqual({n:1});
    expect(db.prepare("SELECT count(*) n FROM jobs WHERE kind='extract_source'").get()).toEqual({n:1});
  });
  it('discovers mail moved into Inbox and deduplicates its history references', async () => {
    const sources=new SourceRepository(db,keyFromSecret('secret'),()=>now);sources.ensureGmailState('c1',1);
    db.prepare("UPDATE sync_states SET cursor='10', query_version='gmail-history'").run();
    const provider=new FakeGoogleProvider({}, {messages:{moved:message('moved','keep'),archived:{...message('archived','skip'),labelIds:[]}},history:{'10':{items:[{messagesAdded:[{message:{id:'moved'}},{message:{id:'archived'}}],labelsAdded:[{message:{id:'moved'},labelIds:['INBOX']}]}],historyId:'12'}}});
    const get=vi.spyOn(provider,'getGmailMessage');await runWith(provider);
    expect(get).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT count(*) n FROM source_items').get()).toEqual({n:1});
  });
  function runWith(provider: FakeGoogleProvider) {
    sync = new GmailSync(db, keyFromSecret('secret'), provider, queue, new SourceRepository(db, keyFromSecret('secret'), () => now), () => now);
    queue.enqueue({ kind: 'gmail_sync', scopeId: 'c1', dedupeKey: 'refresh-test', payload: { connectionId: 'c1', generation: 1 } });
    return sync.run(queue.claim(['gmail_sync'])!);
  }
  function expire() {
    db.prepare('UPDATE google_connections SET encrypted_tokens = ?').run(JSON.stringify(encryptJson({ ...grant, expiresAt: '2020-01-01T00:00:00Z' }, keyFromSecret('secret'), 'google-connection:c1')));
  }
  it('refreshes an expired grant before Gmail reads and reuses the stored token', async () => {
    expire(); const provider = new FakeGoogleProvider();
    const refresh = vi.spyOn(provider, 'refresh').mockResolvedValue({ ...grant, accessToken: 'renewed' });
    const profile = vi.spyOn(provider, 'getGmailProfile');
    const list = vi.spyOn(provider, 'listGmailMessages');
    expect(await runWith(provider)).toEqual({ state: 'complete' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(profile).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'renewed' }));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'renewed' }), expect.anything());
  });
  it('waits for another refresh without reading Gmail', async () => {
    expire(); db.prepare('INSERT INTO google_refresh_leases VALUES (?, ?, ?)').run('c1', 'other-worker', new Date(now.getTime() + 60000).toISOString());
    const provider = new FakeGoogleProvider(); const profile = vi.spyOn(provider, 'getGmailProfile');
    expect(await runWith(provider)).toMatchObject({ state: 'retry', retryKind: 'continuation' });
    expect(profile).not.toHaveBeenCalled();
  });
  it('stops on revoked consent and does not fetch Gmail', async () => {
    expire(); const provider = new FakeGoogleProvider();
    vi.spyOn(provider, 'refresh').mockRejectedValue(new Error('GOOGLE_REAUTH_REQUIRED'));
    const profile = vi.spyOn(provider, 'getGmailProfile');
    expect(await runWith(provider)).toEqual({ state: 'complete' });
    expect(profile).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status, generation FROM google_connections').get()).toEqual({ status: 'needs_reauth', generation: 2 });
  });
  it('discards a fetched message when its owner becomes disabled during the request', async () => {
    const provider = new FakeGoogleProvider({}, { messages: { m1: message('m1', 'private source') } });
    vi.spyOn(provider, 'getGmailMessage').mockImplementation(async () => {
      db.prepare('UPDATE members SET active = 0').run(); return message('m1', 'private source');
    });
    expect(await runWith(provider)).toEqual({ state: 'complete' });
    expect(db.prepare('SELECT count(*) AS count FROM source_versions').get()).toEqual({ count: 0 });
  });
});

describe('Inbox scope', () => {
  it('allows Inbox categories and rejects archived, sent-only, draft, spam and trash messages', async () => {
    const {isInboxMessage}=await import('./gmail-scope.js');
    expect(isInboxMessage({labels:['INBOX','CATEGORY_PROMOTIONS']})).toBe(true);
    for(const labels of [[],['SENT'],['CATEGORY_UPDATES'],['INBOX','DRAFT'],['INBOX','SPAM'],['INBOX','TRASH']]) expect(isInboxMessage({labels})).toBe(false);
  });
});

it('reads case-insensitive subject and sender headers',()=>{
 const value=normalizeMessage({id:'headers',payload:{headers:[{name:'Subject',value:'Invitation'},{name:'FROM',value:'Person <person@example.test>'}]}});
 expect(value.subject).toBe('Invitation');expect(value.sender).toBe('Person <person@example.test>');
});
