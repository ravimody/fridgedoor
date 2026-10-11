import type Database from 'better-sqlite3';
import { JobQueue, type JobRecord } from '../jobs/queue.js';
import { CalendarRepository, type CalendarStream } from '../repos/calendar.js';
import { normalizeGoogleTime } from '../domain/time.js';
import type { GoogleProvider, GoogleGrant, GoogleEvent } from '../providers/google.js';
import { GoogleTokenService } from '../services/google-tokens.js';

export type CalendarSyncResult = { state: 'complete' } | { state: 'retry'; retryKind: 'continuation'|'transient'; delayMs?: number };
const WINDOW_BEFORE_MS = 7 * 86400000; const WINDOW_AFTER_MS = 90 * 86400000;
const retry = (job: JobRecord, retryKind: 'continuation'|'transient' = 'transient'): CalendarSyncResult => ({ state: 'retry', retryKind, delayMs: Math.min(30 * 60_000, Math.max(30_000, 2 ** Math.min(job.attemptCount, 6) * 1000)) });

export class CalendarSync {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly provider: GoogleProvider, private readonly queue: JobQueue, private readonly calendars: CalendarRepository, private readonly clock: () => Date = () => new Date()) {}
  private current(job: JobRecord): CalendarStream | undefined { const id = job.payload.calendarSelectionId; if (!id || job.payload.generation === undefined) throw new Error('JOB_PAYLOAD_INVALID'); const stream = this.calendars.stream(id); return stream && stream.connectionId === job.payload.connectionId && stream.generation === job.payload.generation ? stream : undefined; }
  private async request<T>(job: JobRecord, stream: CalendarStream, operation: (grant: GoogleGrant) => Promise<T>): Promise<T> {
    const grant = await new GoogleTokenService(this.db, this.key, this.provider, this.clock).grant(stream.connectionId, stream.generation);
    if (!this.current(job)) throw new Error('GOOGLE_CONNECTION_INACTIVE');
    try {
      const result = await operation(grant);
      if (!this.current(job)) throw new Error('GOOGLE_CONNECTION_INACTIVE');
      return result;
    } catch (error) {
      if (!this.current(job)) throw new Error('GOOGLE_CONNECTION_INACTIVE');
      throw error;
    }
  }
  private async persistEvents(job: JobRecord, stream: CalendarStream, events: GoogleEvent[]) {
    for (const event of events) {
      if (!this.current(job)) throw new Error('GOOGLE_CONNECTION_INACTIVE');
      if (!event.id) continue;
      const time = normalizeGoogleTime(event.start, event.end);
      const visibility = stream.isDestination ? 'destination_context' : stream.classification === 'household' ? 'shared_eligible' : 'owner';
      this.calendars.persist(stream, event, time, visibility);
      if (event.recurrence?.length && event.status !== 'cancelled') {
        const calendarId = this.calendars.calendarId(stream); const now = new Date(this.calendars.state(stream)?.calendar_refresh_started_at ?? this.clock().toISOString()); let pageToken: string | undefined;
        do { const page = await this.request(job, stream, (grant) => this.provider.listCalendarInstances(grant, calendarId, event.id, { timeMin: new Date(now.getTime() - WINDOW_BEFORE_MS).toISOString(), timeMax: new Date(now.getTime() + WINDOW_AFTER_MS).toISOString(), ...(pageToken ? { pageToken } : {}) })); await this.persistEvents(job, stream, page.items); pageToken = page.nextPageToken; } while (pageToken);
      }
    }
  }
  async run(job: JobRecord): Promise<CalendarSyncResult> {
    const stream = this.current(job); if (!stream) return { state: 'complete' };
    this.calendars.ensureState(stream); const lease = this.calendars.acquire(stream); if (!lease) return retry(job);
    try {
      const state = this.calendars.beginRefreshIfDue(stream); const calendarId = this.calendars.calendarId(stream); const page = await this.request(job, stream, (grant) => this.provider.listCalendarEvents(grant, calendarId, { ...(state.page_token ? { pageToken: state.page_token } : {}), ...(state.cursor ? { syncToken: state.cursor } : {}) }));
      await this.persistEvents(job, stream, page.items);
      if (page.nextPageToken) { this.calendars.setPage(stream, page.nextPageToken); return retry(job, 'continuation'); }
      if (!page.nextSyncToken) throw new Error('GOOGLE_CALENDAR_CURSOR_MISSING');
      this.calendars.complete(stream, page.nextSyncToken); return { state: 'complete' };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'CALENDAR_SYNC_FAILED';
      if (['GOOGLE_CONNECTION_INACTIVE', 'GOOGLE_CONNECTION_CHANGED', 'GOOGLE_REAUTH_REQUIRED'].includes(code) || !this.current(job)) return { state: 'complete' };
      if (code === 'GOOGLE_REFRESH_BUSY') return retry(job, 'continuation');
      if (code === 'GOOGLE_INVALID_GRANT') { this.db.prepare("UPDATE google_connections SET status = 'needs_reauth', generation = generation + 1, revision = revision + 1, updated_at = ? WHERE id = ? AND generation = ?").run(this.clock().toISOString(), stream.connectionId, stream.generation); this.queue.cancelScope(stream.connectionId, 'NEEDS_REAUTH'); this.calendars.error(stream, code); return { state: 'complete' }; }
      if (code === 'GOOGLE_CALENDAR_SYNC_EXPIRED') { this.calendars.reset(stream); this.calendars.error(stream, code); return retry(job); }
      this.calendars.error(stream, code.slice(0, 80)); return retry(job);
    } finally { this.calendars.release(stream, lease); }
  }
}
