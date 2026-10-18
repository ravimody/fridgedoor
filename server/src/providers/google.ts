import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'] as const;
export type GoogleGrant = { sub: string; email: string; scopes: string[]; accessToken: string; refreshToken?: string; expiresAt: string };
export type GmailPart = { mimeType?: string; filename?: string; headers?: Array<{ name?: string; value?: string }>; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GmailPart[] };
export type GmailMessage = { id: string; threadId?: string; historyId?: string; internalDate?: string; labelIds?: string[]; payload?: GmailPart; snippet?: string };
export type GmailAttachment = { data?: string; size?: number };
export type GmailMessageRef = { id: string; threadId?: string };
export type GmailHistoryEvent = { labelsAdded?: Array<{ message?: GmailMessageRef; labelIds?: string[] }>; id?: string; messagesAdded?: Array<{ message?: GmailMessageRef }>; messagesDeleted?: Array<{ message?: GmailMessageRef }>; messages?: Array<{ id?: string }> };
export type GmailPage<T> = { items: T[]; nextPageToken?: string; historyId?: string };
export type GmailProvider = {
  getGmailProfile(grant: GoogleGrant): Promise<{ historyId: string }>;
  listGmailMessages(grant: GoogleGrant, input: { query: string; pageToken?: string; maxResults: number }): Promise<GmailPage<GmailMessageRef>>;
  getGmailMessage(grant: GoogleGrant, id: string): Promise<GmailMessage>;
  getGmailAttachment(grant: GoogleGrant, messageId: string, attachmentId: string): Promise<GmailAttachment>;
  listGmailHistory(grant: GoogleGrant, input: { startHistoryId: string; pageToken?: string }): Promise<GmailPage<GmailHistoryEvent>>;
};
export type GoogleCalendar = { id: string; summary: string; accessRole: 'reader' | 'writer' | 'owner'; primary?: boolean };
export type GoogleEvent = { id: string; status?: 'confirmed' | 'tentative' | 'cancelled'; summary?: string; description?: string; location?: string; start?: { date?: string; dateTime?: string; timeZone?: string }; end?: { date?: string; dateTime?: string; timeZone?: string }; recurrence?: string[]; recurringEventId?: string; originalStartTime?: { date?: string; dateTime?: string; timeZone?: string }; eventType?: string; etag?: string; updated?: string; iCalUID?: string };
export type GoogleEventWrite = { summary: string; description: string; location?: string; start: { date?: string; dateTime?: string; timeZone?: string }; end: { date?: string; dateTime?: string; timeZone?: string } };
export type CalendarPage = { items: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };
export type CalendarProvider = { listCalendarEvents(grant: GoogleGrant, calendarId: string, input: { pageToken?: string; syncToken?: string }): Promise<CalendarPage>; listCalendarInstances(grant: GoogleGrant, calendarId: string, recurringEventId: string, input: { timeMin: string; timeMax: string; pageToken?: string }): Promise<CalendarPage> };
export type GoogleProvider = GmailProvider & CalendarProvider & { authorizationUrl(input: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): string; exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; nonce: string }): Promise<GoogleGrant>; refresh(grant: GoogleGrant): Promise<GoogleGrant>; listCalendars(grant: GoogleGrant): Promise<GoogleCalendar[]>; revoke(grant: GoogleGrant): Promise<void>; getCalendarEvent(grant: GoogleGrant, calendarId: string, eventId: string): Promise<GoogleEvent | null>; createCalendarEvent(grant: GoogleGrant, calendarId: string, eventId: string, input: GoogleEventWrite): Promise<GoogleEvent>; updateCalendarEvent(grant: GoogleGrant, calendarId: string, eventId: string, input: GoogleEventWrite, etag?: string): Promise<GoogleEvent>; deleteCalendarEvent(grant: GoogleGrant, calendarId: string, eventId: string, etag?: string): Promise<void> };
export class FakeGoogleProvider implements GoogleProvider {
  constructor(private readonly grants: Record<string, GoogleGrant> = {}, private readonly mail: { profile?: { historyId: string }; messages?: Record<string, GmailMessage>; pages?: Record<string, GmailPage<GmailMessageRef>>; history?: Record<string, GmailPage<GmailHistoryEvent>>; attachments?: Record<string, GmailAttachment> } = {}, private readonly calendar: { events?: Record<string, CalendarPage>; instances?: Record<string, CalendarPage> } = {}) {}
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string; redirectUri: string }) { const query = new URLSearchParams({ client_id: 'fake-client', redirect_uri: input.redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state: input.state, nonce: input.nonce, code_challenge: input.codeChallenge, code_challenge_method: 'S256' }); return `https://accounts.google.com/o/oauth2/v2/auth?${query}`; }
  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; nonce: string }) { if (!input.code || !input.codeVerifier || !input.nonce) throw new Error('GOOGLE_OAUTH_FAILED'); const grant = this.grants[input.code]; if (!grant) throw new Error('GOOGLE_OAUTH_FAILED'); return grant; }
  async listCalendars(): Promise<GoogleCalendar[]> { return [{ id: 'fake-shared-calendar', summary: 'Household', accessRole: 'owner', primary: true }]; }
  async revoke() {}
  async getGmailProfile(): Promise<{ historyId: string }> { return this.mail.profile ?? { historyId: '100' }; }
  async listGmailMessages(_grant: GoogleGrant, input: { query: string; pageToken?: string; maxResults: number }): Promise<GmailPage<GmailMessageRef>> { const configured = this.mail.pages?.[input.pageToken ?? 'first']; if (configured) return configured; const items = Object.values(this.mail.messages ?? {}).map(({ id, threadId }) => ({ id, ...(threadId ? { threadId } : {}) })); return { items, historyId: this.mail.profile?.historyId ?? '100' }; }
  async getGmailMessage(_grant: GoogleGrant, id: string) { const message = this.mail.messages?.[id]; if (!message) throw new Error('GOOGLE_MESSAGE_NOT_FOUND'); return message; }
  async getGmailAttachment(_grant: GoogleGrant, messageId: string, attachmentId: string) { const attachment = this.mail.attachments?.[`${messageId}:${attachmentId}`]; if (!attachment) throw new Error('GOOGLE_ATTACHMENT_NOT_FOUND'); return attachment; }
  async listGmailHistory(_grant: GoogleGrant, input: { startHistoryId: string; pageToken?: string }) { return this.mail.history?.[input.pageToken ?? input.startHistoryId] ?? { items: [], historyId: this.mail.profile?.historyId ?? input.startHistoryId }; }
  async listCalendarEvents(_grant: GoogleGrant, calendarId: string, input: { pageToken?: string; syncToken?: string }) { return this.calendar.events?.[`${calendarId}:${input.pageToken ?? input.syncToken ?? 'initial'}`] ?? { items: [] }; }
  async listCalendarInstances(_grant: GoogleGrant, calendarId: string, recurringEventId: string, input: { timeMin: string; timeMax: string; pageToken?: string }) { return this.calendar.instances?.[`${calendarId}:${recurringEventId}:${input.pageToken ?? 'initial'}`] ?? { items: [] }; }
  async getCalendarEvent(_grant: GoogleGrant, _calendarId: string, eventId: string) { return this.written.get(eventId) ?? null; }
  async createCalendarEvent(_grant: GoogleGrant, _calendarId: string, eventId: string, input: GoogleEventWrite) { const event = { id: eventId, ...input, etag: `etag-${eventId}` }; this.written.set(eventId, event); return event; }
  async updateCalendarEvent(_grant: GoogleGrant, _calendarId: string, eventId: string, input: GoogleEventWrite, etag?: string) { const current = this.written.get(eventId); if (!current) throw new Error('GOOGLE_CALENDAR_NOT_FOUND'); if (etag && current.etag !== etag) throw new Error('GOOGLE_CALENDAR_CONFLICT'); const event = { ...current, ...input, etag: `etag-${eventId}-next` }; this.written.set(eventId, event); return event; }
  async deleteCalendarEvent(_grant: GoogleGrant, _calendarId: string, eventId: string, etag?: string) { const current = this.written.get(eventId); if (!current) return; if (etag && current.etag !== etag) throw new Error('GOOGLE_CALENDAR_CONFLICT'); this.written.set(eventId, { ...current, status: 'cancelled' }); }
  private readonly written = new Map<string, GoogleEvent>();
  async refresh(grant: GoogleGrant): Promise<GoogleGrant> {
    if (!grant.refreshToken) throw new Error('GOOGLE_REAUTH_REQUIRED');
    return { ...grant, accessToken: 'fake-refreshed-access', expiresAt: new Date(Date.now() + 3600000).toISOString() };
  }
}
export class GoogleApiProvider implements GoogleProvider {
  private readonly keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
  constructor(private readonly clientId: string, private readonly clientSecret: string) {}
  async refresh(grant: GoogleGrant): Promise<GoogleGrant> {
    if (!grant.refreshToken?.trim()) throw new Error('GOOGLE_REAUTH_REQUIRED');
    let response: Response;
    try {
      response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret,
          refresh_token: grant.refreshToken, grant_type: 'refresh_token' }),
      });
    } catch { throw new Error('GOOGLE_REFRESH_FAILED'); }
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error('GOOGLE_REFRESH_FAILED'); }
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(body);
      throw new Error(response.status === 400 && error.success && error.data.error === 'invalid_grant'
        ? 'GOOGLE_REAUTH_REQUIRED' : 'GOOGLE_REFRESH_FAILED');
    }
    const parsed = z.object({ access_token: z.string().trim().min(1),
      token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
      expires_in: z.number().finite().positive().max(86400),
      refresh_token: z.string().trim().min(1).optional(), scope: z.string().optional(),
    }).safeParse(body);
    if (!parsed.success) throw new Error('GOOGLE_REFRESH_FAILED');
    const token = parsed.data;
    const scopes = token.scope === undefined ? grant.scopes : token.scope.split(/\s+/).filter(Boolean);
    const canonical = (scope: string) => scope === 'https://www.googleapis.com/auth/userinfo.email' ? 'email' : scope;
    const expected = new Set(grant.scopes.map(canonical));
    const actual = new Set(scopes.map(canonical));
    if (actual.size !== expected.size || [...expected].some((scope) => !actual.has(scope))) throw new Error('GOOGLE_REAUTH_REQUIRED');
    return { ...grant, accessToken: token.access_token, refreshToken: token.refresh_token ?? grant.refreshToken,
      scopes, expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() };
  }
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string; redirectUri: string }) { const query = new URLSearchParams({ client_id: this.clientId, redirect_uri: input.redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state: input.state, nonce: input.nonce, code_challenge: input.codeChallenge, code_challenge_method: 'S256' }); return `https://accounts.google.com/o/oauth2/v2/auth?${query}`; }
  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; nonce: string }) { const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: input.code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: input.redirectUri, grant_type: 'authorization_code', code_verifier: input.codeVerifier }) }); if (!response.ok) throw new Error('GOOGLE_OAUTH_FAILED'); const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string }; if (!token.access_token || !token.id_token) throw new Error('GOOGLE_OAUTH_FAILED'); let payload; try { ({ payload } = await jwtVerify(token.id_token, this.keys as never, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: this.clientId })); } catch { throw new Error('GOOGLE_OAUTH_FAILED'); } if (payload.nonce !== input.nonce) throw new Error('GOOGLE_OAUTH_FAILED'); if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || payload.email_verified !== true) throw new Error('GOOGLE_ACCOUNT_UNVERIFIED'); return { sub: payload.sub, email: payload.email, scopes: (token.scope ?? '').split(' ').filter(Boolean), accessToken: token.access_token, ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}), expiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString() }; }
  async listCalendars(grant: GoogleGrant) { const response = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', { headers: { Authorization: `Bearer ${grant.accessToken}` } }); if (!response.ok) throw new Error('GOOGLE_CALENDAR_FAILED'); const body = await response.json() as { items?: Array<{ id?: string; summary?: string; accessRole?: string; primary?: boolean }> }; return (body.items ?? []).filter((item): item is { id: string; summary: string; accessRole: 'reader'|'writer'|'owner'; primary?: boolean } => Boolean(item.id && item.summary && (item.accessRole === 'reader' || item.accessRole === 'writer' || item.accessRole === 'owner'))).map((item) => ({ id: item.id, summary: item.summary, accessRole: item.accessRole, ...(item.primary ? { primary: true } : {}) })); }
  /** Revoking the refresh token also ends its access tokens at Google. The token goes in the body, never the URL. */
  async revoke(grant: GoogleGrant) { const response = await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: grant.refreshToken ?? grant.accessToken }), signal: AbortSignal.timeout(10_000) }); if (!response.ok && response.status !== 400) throw new Error('GOOGLE_REVOKE_FAILED'); }
  private async gmail<T>(path: string, grant: GoogleGrant, notFoundCode = 'GOOGLE_HISTORY_EXPIRED'): Promise<T> { const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${grant.accessToken}` } }); if (response.status === 401) throw new Error('GOOGLE_INVALID_GRANT'); if (response.status === 404) throw new Error(notFoundCode); if (!response.ok) throw new Error(response.status === 429 || response.status >= 500 ? 'GOOGLE_RETRYABLE' : 'GOOGLE_GMAIL_FAILED'); return response.json() as Promise<T>; }
  async getGmailProfile(grant: GoogleGrant) { return this.gmail<{ historyId: string }>('profile', grant); }
  async listGmailMessages(grant: GoogleGrant, input: { query: string; pageToken?: string; maxResults: number }) { const query = new URLSearchParams({ q: input.query, maxResults: String(input.maxResults), ...(input.pageToken ? { pageToken: input.pageToken } : {}) }); const body = await this.gmail<{ messages?: GmailMessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }>(`messages?${query}`, grant); return { items: body.messages ?? [], ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}) }; }
  async getGmailMessage(grant: GoogleGrant, id: string) { return this.gmail<GmailMessage>(`messages/${encodeURIComponent(id)}?format=full`, grant, 'GOOGLE_MESSAGE_NOT_FOUND'); }
  async getGmailAttachment(grant: GoogleGrant, messageId: string, attachmentId: string) { return this.gmail<GmailAttachment>(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, grant, 'GOOGLE_ATTACHMENT_NOT_FOUND'); }
  async listGmailHistory(grant: GoogleGrant, input: { startHistoryId: string; pageToken?: string }) { const query = new URLSearchParams({ startHistoryId: input.startHistoryId, labelId: 'INBOX', ...(input.pageToken ? { pageToken: input.pageToken } : {}) }); const body = await this.gmail<{ history?: GmailHistoryEvent[]; nextPageToken?: string; historyId?: string }>(`history?${query}`, grant); return { items: body.history ?? [], ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}), ...(body.historyId ? { historyId: body.historyId } : {}) }; }
  private async calendar<T>(calendarId: string, path: string, grant: GoogleGrant): Promise<T> { const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/${path}`, { headers: { Authorization: `Bearer ${grant.accessToken}` } }); if (response.status === 401) throw new Error('GOOGLE_INVALID_GRANT'); if (response.status === 410) throw new Error('GOOGLE_CALENDAR_SYNC_EXPIRED'); if (response.status === 404) throw new Error('GOOGLE_CALENDAR_NOT_FOUND'); if (!response.ok) throw new Error(response.status === 429 || response.status >= 500 ? 'GOOGLE_RETRYABLE' : 'GOOGLE_CALENDAR_FAILED'); return response.json() as Promise<T>; }
  async listCalendarEvents(grant: GoogleGrant, calendarId: string, input: { pageToken?: string; syncToken?: string }) { const query = new URLSearchParams({ singleEvents: 'false', showDeleted: 'true', ...(input.pageToken ? { pageToken: input.pageToken } : {}), ...(input.syncToken ? { syncToken: input.syncToken } : {}) }); const body = await this.calendar<CalendarPage>(calendarId, `events?${query}`, grant); return { items: body.items ?? [], ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}), ...(body.nextSyncToken ? { nextSyncToken: body.nextSyncToken } : {}) }; }
  async listCalendarInstances(grant: GoogleGrant, calendarId: string, recurringEventId: string, input: { timeMin: string; timeMax: string; pageToken?: string }) { const query = new URLSearchParams({ showDeleted: 'true', timeMin: input.timeMin, timeMax: input.timeMax, ...(input.pageToken ? { pageToken: input.pageToken } : {}) }); const body = await this.calendar<CalendarPage>(calendarId, `events/${encodeURIComponent(recurringEventId)}/instances?${query}`, grant); return { items: body.items ?? [], ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}), ...(body.nextSyncToken ? { nextSyncToken: body.nextSyncToken } : {}) }; }
  async getCalendarEvent(grant: GoogleGrant, calendarId: string, eventId: string) { try { return await this.calendar<GoogleEvent>(calendarId, `events/${encodeURIComponent(eventId)}`, grant); } catch (error) { if (error instanceof Error && error.message === 'GOOGLE_CALENDAR_NOT_FOUND') return null; throw error; } }
  async createCalendarEvent(grant: GoogleGrant, calendarId: string, eventId: string, input: GoogleEventWrite) { return this.calendarWrite<GoogleEvent>(calendarId, 'events', grant, 'POST', { ...input, id: eventId }); }
  async updateCalendarEvent(grant: GoogleGrant, calendarId: string, eventId: string, input: GoogleEventWrite, etag?: string) { return this.calendarWrite<GoogleEvent>(calendarId, `events/${encodeURIComponent(eventId)}`, grant, 'PATCH', input, etag); }
  async deleteCalendarEvent(grant: GoogleGrant, calendarId: string, eventId: string, etag?: string) { await this.calendarWrite<unknown>(calendarId, `events/${encodeURIComponent(eventId)}`, grant, 'DELETE', undefined, etag); }
  private async calendarWrite<T>(calendarId: string, path: string, grant: GoogleGrant, method: 'POST'|'PATCH'|'DELETE', body?: unknown, etag?: string): Promise<T> { const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/${path}`, { method, headers: { Authorization: `Bearer ${grant.accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(etag ? { 'If-Match': etag } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); if (response.status === 401) throw new Error('GOOGLE_INVALID_GRANT'); if (response.status === 404) throw new Error('GOOGLE_CALENDAR_NOT_FOUND'); if (response.status === 412) throw new Error('GOOGLE_CALENDAR_CONFLICT'); if (!response.ok) throw new Error(response.status === 429 || response.status >= 500 ? 'GOOGLE_RETRYABLE' : 'GOOGLE_CALENDAR_FAILED'); return response.status === 204 ? undefined as T : response.json() as Promise<T>; }
}

/** Keeps the preview reachable while making a missing live OAuth setup explicit. */
export class UnconfiguredGoogleProvider implements GoogleProvider {
  private unavailable(): never { throw new Error('GOOGLE_NOT_CONFIGURED'); }
  authorizationUrl(): string { return this.unavailable(); }
  async exchangeCode(): Promise<GoogleGrant> { return this.unavailable(); }
  async refresh(): Promise<GoogleGrant> { return this.unavailable(); }
  async listCalendars(): Promise<GoogleCalendar[]> { return this.unavailable(); }
  async revoke(): Promise<void> { return this.unavailable(); }
  async getGmailProfile(): Promise<{ historyId: string }> { return this.unavailable(); }
  async listGmailMessages(): Promise<GmailPage<GmailMessageRef>> { return this.unavailable(); }
  async getGmailMessage(): Promise<GmailMessage> { return this.unavailable(); }
  async getGmailAttachment(): Promise<GmailAttachment> { return this.unavailable(); }
  async listGmailHistory(): Promise<GmailPage<GmailHistoryEvent>> { return this.unavailable(); }
  async listCalendarEvents(): Promise<CalendarPage> { return this.unavailable(); }
  async listCalendarInstances(): Promise<CalendarPage> { return this.unavailable(); }
  async getCalendarEvent(): Promise<GoogleEvent | null> { return this.unavailable(); }
  async createCalendarEvent(): Promise<GoogleEvent> { return this.unavailable(); }
  async updateCalendarEvent(): Promise<GoogleEvent> { return this.unavailable(); }
  async deleteCalendarEvent(): Promise<void> { return this.unavailable(); }
}

export function createGoogleProvider(clientId?: string, clientSecret?: string): GoogleProvider {
  if (clientId && clientSecret) return new GoogleApiProvider(clientId, clientSecret);
  if (clientId || clientSecret) throw new Error('GOOGLE_CLIENT_CONFIGURATION_INCOMPLETE');
  return new UnconfiguredGoogleProvider();
}
