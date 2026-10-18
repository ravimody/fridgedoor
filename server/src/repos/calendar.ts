import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { decryptJson, encryptJson, indexKey } from '../crypto.js';
import type { GoogleEvent } from '../providers/google.js';
import type { NormalizedTime } from '@fridgedoor/contracts';

export type CalendarStream = { selectionId: string; connectionId: string; memberId: string; householdId: string; encryptedCalendarId: string; classification: 'household'|'personal'|'work'; generation: number; encryptedTokens: string; isDestination: boolean };
export type CalendarEventPayload = { providerEventId: string; summary?: string; description?: string; location?: string; iCalUID?: string; recurringEventId?: string; originalStartTime?: string; normalizedTime: NormalizedTime; visibility: 'owner'|'shared_eligible'|'destination_context' };
type SyncRow = { id: string; connection_id: string; source_kind: string; stream_key: string; cursor: string | null; page_token: string | null; generation: number; stream_lease_token: string | null; stream_lease_until: string | null; calendar_full_sync_at: string | null; calendar_refresh_token: string | null; calendar_refresh_started_at: string | null; last_success_at: string | null };
export type CalendarSyncState = SyncRow;
export type CalendarDateWindow = { startUtc: string; endUtc: string; startDate: string; endDateExclusive: string };
export type CalendarContextItem = {
  id: string;
  sourceId: string;
  providerEventId: string;
  iCalUID?: string;
  originalStartTime?: string;
  planId?: string;
  title: string;
  time: NormalizedTime;
  status: 'confirmed' | 'tentative';
  visibility: 'owner' | 'shared';
  generation: number;
  sourceOwnerId: string;
  location?: string;
};

export class CalendarRepository {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly clock: () => Date = () => new Date()) {}
  // A member's calendar is read when they selected it. The household's destination is also read through the
  // copy of the member who chose it (the binding keeps that copy's encrypted id), never through others' copies.
  streams() { return this.db.prepare("SELECT cs.id as selectionId, gc.id as connectionId, m.id as memberId, m.household_id as householdId, cs.encrypted_calendar_id as encryptedCalendarId, cs.classification, cs.generation, gc.encrypted_tokens as encryptedTokens, CASE WHEN db.id IS NULL THEN 0 ELSE 1 END as isDestination FROM calendar_selections cs JOIN google_connections gc ON gc.id = cs.connection_id JOIN members m ON m.id = gc.member_id LEFT JOIN destination_bindings db ON db.household_id = m.household_id AND db.calendar_key = cs.calendar_key AND db.active = 1 WHERE (cs.selected = 1 OR (db.id IS NOT NULL AND db.encrypted_calendar_id = cs.encrypted_calendar_id AND cs.classification <> 'work')) AND m.active = 1 AND gc.status = 'active' AND cs.generation = gc.generation").all().map((row) => ({ ...(row as CalendarStream), isDestination: Boolean((row as CalendarStream).isDestination) })) as CalendarStream[]; }
  stream(selectionId: string) { return this.streams().find((value) => value.selectionId === selectionId); }
  calendarId(stream: CalendarStream) { return decryptJson<{ id: string }>(JSON.parse(stream.encryptedCalendarId), this.key, `calendar:${stream.connectionId}:${this.calendarKey(stream)}`).id; }
  private calendarKey(stream: CalendarStream) { return (this.db.prepare('SELECT calendar_key FROM calendar_selections WHERE id = ?').get(stream.selectionId) as { calendar_key: string }).calendar_key; }
  ensureState(stream: CalendarStream) {
    const now = this.clock().toISOString(); const existing = this.db.prepare("SELECT * FROM sync_states WHERE connection_id = ? AND source_kind = 'calendar' AND stream_key = ?").get(stream.connectionId, stream.selectionId) as SyncRow | undefined;
    if (!existing) this.db.prepare("INSERT INTO sync_states (id, connection_id, source_kind, stream_key, query_version, generation, created_at, updated_at) VALUES (?, ?, 'calendar', ?, 'calendar-v1', ?, ?, ?)").run(randomBytes(16).toString('hex'), stream.connectionId, stream.selectionId, stream.generation, now, now);
    else if (existing.generation !== stream.generation) this.db.prepare("UPDATE sync_states SET cursor = NULL, page_token = NULL, calendar_full_sync_at = NULL, calendar_refresh_token = NULL, calendar_refresh_started_at = NULL, query_version = 'calendar-v1', generation = ?, stream_lease_token = NULL, stream_lease_until = NULL, error_code = NULL, updated_at = ? WHERE id = ?").run(stream.generation, now, existing.id);
    return this.state(stream);
  }
  state(stream: CalendarStream) { return this.db.prepare("SELECT id, connection_id, source_kind, stream_key, cursor, page_token, generation, stream_lease_token, stream_lease_until, calendar_full_sync_at, calendar_refresh_token, calendar_refresh_started_at, last_success_at FROM sync_states WHERE connection_id = ? AND source_kind = 'calendar' AND stream_key = ?").get(stream.connectionId, stream.selectionId) as SyncRow | undefined; }
  acquire(stream: CalendarStream, leaseMs = 60_000) { const now = this.clock(); const token = randomBytes(24).toString('base64url'); const result = this.db.prepare("UPDATE sync_states SET stream_lease_token = ?, stream_lease_until = ?, updated_at = ? WHERE id = ? AND generation = ? AND (stream_lease_until IS NULL OR stream_lease_until <= ?)").run(token, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), this.state(stream)!.id, stream.generation, now.toISOString()); return result.changes === 1 ? token : null; }
  release(stream: CalendarStream, token: string) { this.db.prepare('UPDATE sync_states SET stream_lease_token = NULL, stream_lease_until = NULL, updated_at = ? WHERE connection_id = ? AND source_kind = ? AND stream_key = ? AND stream_lease_token = ?').run(this.clock().toISOString(), stream.connectionId, 'calendar', stream.selectionId, token); }
  setPage(stream: CalendarStream, pageToken: string | null) { this.db.prepare("UPDATE sync_states SET page_token = ?, updated_at = ? WHERE connection_id = ? AND source_kind = 'calendar' AND stream_key = ? AND generation = ?").run(pageToken, this.clock().toISOString(), stream.connectionId, stream.selectionId, stream.generation); }
  beginRefreshIfDue(stream: CalendarStream) {
    const state = this.state(stream)!; const now = this.clock();
    // Finish an existing page chain before replacing its cursor. Retain the
    // prior agenda until every full-sync page and recurring instance succeeds.
    if (!state.calendar_refresh_token && !state.page_token && (!state.cursor || !state.calendar_full_sync_at || Date.parse(state.calendar_full_sync_at) <= now.getTime() - 86400000)) {
      this.db.prepare('UPDATE sync_states SET cursor=NULL, calendar_refresh_token=?, calendar_refresh_started_at=? WHERE id=? AND generation=?').run(randomBytes(16).toString('hex'), now.toISOString(), state.id, stream.generation);
    }
    return this.state(stream)!;
  }
  complete(stream: CalendarStream, cursor: string) {
    this.db.transaction(() => {
      const state = this.state(stream)!; const now = this.clock().toISOString();
      if (state.calendar_refresh_token) {
        this.db.prepare('DELETE FROM calendar_occurrences WHERE calendar_selection_id=? AND generation=? AND refresh_token IS NOT ?').run(stream.selectionId, stream.generation, state.calendar_refresh_token);
      }
      this.db.prepare("UPDATE sync_states SET cursor=?, page_token=NULL, error_code=NULL, last_success_at=?, updated_at=?, calendar_full_sync_at=CASE WHEN calendar_refresh_token IS NOT NULL THEN ? ELSE calendar_full_sync_at END, calendar_refresh_token=NULL, calendar_refresh_started_at=NULL WHERE id=? AND generation=?").run(cursor, now, now, now, state.id, stream.generation);
    })();
  }
  error(stream: CalendarStream, code: string) { this.db.prepare("UPDATE sync_states SET error_code = ?, updated_at = ? WHERE connection_id = ? AND source_kind = 'calendar' AND stream_key = ?").run(code, this.clock().toISOString(), stream.connectionId, stream.selectionId); }
  reset(stream: CalendarStream) { this.db.prepare("UPDATE sync_states SET cursor=NULL, page_token=NULL, error_code=NULL, calendar_full_sync_at=NULL, calendar_refresh_token=NULL, calendar_refresh_started_at=NULL, updated_at=? WHERE connection_id=? AND source_kind='calendar' AND stream_key=?").run(this.clock().toISOString(), stream.connectionId, stream.selectionId); }

  persist(stream: CalendarStream, event: GoogleEvent, normalizedTime: NormalizedTime, visibility: CalendarEventPayload['visibility']) {
    const now = this.clock().toISOString(); const eventKey = indexKey(event.id, this.key); const occurrenceKey = event.recurringEventId ? `${event.recurringEventId}:${JSON.stringify(event.originalStartTime ?? event.start ?? {})}` : event.id; const occurrenceIndex = indexKey(occurrenceKey, this.key); const occurrenceId = randomBytes(16).toString('hex'); const sourceId = randomBytes(16).toString('hex'); const payload: CalendarEventPayload = { providerEventId: event.id, ...(event.summary ? { summary: event.summary } : {}), ...(event.description ? { description: event.description } : {}), ...(event.location ? { location: event.location } : {}), ...(event.iCalUID ? { iCalUID: event.iCalUID } : {}), ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}), ...(event.originalStartTime ? { originalStartTime: JSON.stringify(event.originalStartTime) } : {}), normalizedTime, visibility };
    const status = event.eventType && !['default'].includes(event.eventType) ? 'unsupported' : (event.status ?? 'confirmed'); const actualVisibility = status === 'unsupported' ? 'owner' : visibility; payload.visibility = actualVisibility;
    const transaction = this.db.transaction(() => {
      const source = this.db.prepare("SELECT id FROM source_items WHERE owner_id = ? AND kind = 'calendar_event' AND provider_key = ?").get(stream.memberId, eventKey) as { id: string } | undefined;
      const actualSourceId = source?.id ?? sourceId;
      if (!source) this.db.prepare("INSERT INTO source_items (id, household_id, owner_id, connection_id, kind, provider_key, encrypted_provider_refs, state, generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'calendar_event', ?, ?, 'available', ?, ?, ?)").run(actualSourceId, stream.householdId, stream.memberId, stream.connectionId, eventKey, JSON.stringify(encryptJson({ eventId: event.id, calendarSelectionId: stream.selectionId }, this.key, `calendar-source:${actualSourceId}`)), stream.generation, now, now);
      else this.db.prepare("UPDATE source_items SET state = 'available', generation = ?, updated_at = ? WHERE id = ?").run(stream.generation, now, actualSourceId);
      const existing = this.db.prepare('SELECT id FROM calendar_occurrences WHERE calendar_selection_id = ? AND occurrence_key = ?').get(stream.selectionId, occurrenceIndex) as { id: string } | undefined;
      if (existing) this.db.prepare('UPDATE calendar_occurrences SET source_id = ?, provider_event_key = ?, normalized_time_json = ?, encrypted_payload = ?, status = ?, visibility = ?, generation = ?, original_start = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(actualSourceId, eventKey, JSON.stringify(normalizedTime), JSON.stringify(encryptJson(payload, this.key, `calendar-occurrence:${existing.id}`)), status, actualVisibility, stream.generation, payload.originalStartTime ?? null, new Date(this.clock().getTime() + 7 * 86400000).toISOString(), now, existing.id);
      else this.db.prepare('INSERT INTO calendar_occurrences (id, source_id, calendar_selection_id, occurrence_key, provider_event_key, normalized_time_json, encrypted_payload, status, visibility, generation, original_start, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(occurrenceId, actualSourceId, stream.selectionId, occurrenceIndex, eventKey, JSON.stringify(normalizedTime), JSON.stringify(encryptJson(payload, this.key, `calendar-occurrence:${occurrenceId}`)), status, actualVisibility, stream.generation, payload.originalStartTime ?? null, new Date(this.clock().getTime() + 7 * 86400000).toISOString(), now, now);
      this.db.prepare('UPDATE calendar_occurrences SET refresh_token=? WHERE id=?').run(this.state(stream)?.calendar_refresh_token ?? null, existing?.id ?? occurrenceId);
    }); transaction();
  }
  private agendaRows(actor: { memberId: string; householdId: string }) {
    return this.db.prepare("SELECT o.id, o.source_id, o.encrypted_payload, o.status, o.visibility, o.generation, m.id as owner_id FROM calendar_occurrences o JOIN calendar_selections cs ON cs.id = o.calendar_selection_id JOIN google_connections gc ON gc.id = cs.connection_id JOIN members m ON m.id = gc.member_id LEFT JOIN destination_bindings db ON db.household_id = m.household_id AND db.calendar_key = cs.calendar_key AND db.active = 1 WHERE m.household_id = ? AND m.active = 1 AND gc.status = 'active' AND gc.generation = cs.generation AND o.generation = cs.generation AND (cs.selected = 1 OR (db.id IS NOT NULL AND db.encrypted_calendar_id = cs.encrypted_calendar_id AND cs.classification <> 'work')) AND o.status != 'cancelled' AND o.expires_at > ? AND ((o.visibility = 'shared_eligible') OR (m.id = ? AND o.visibility = 'owner') OR o.visibility = 'destination_context')").all(actor.householdId, this.clock().toISOString(), actor.memberId) as Array<{ id: string; source_id: string; encrypted_payload: string; status: string; visibility: string; generation: number; owner_id: string }>;
  }
  private agendaItems(actor: { memberId: string; householdId: string }, window?: CalendarDateWindow, excludeUnsupported = false): CalendarContextItem[] {
    return this.agendaRows(actor).flatMap((row) => {
      if (excludeUnsupported && row.status === 'unsupported') return [];
      const payload = decryptJson<CalendarEventPayload>(JSON.parse(row.encrypted_payload), this.key, `calendar-occurrence:${row.id}`);
      if (window && !calendarTimeOverlaps(payload.normalizedTime, window)) return [];
      const binding = this.db.prepare(`SELECT p.id FROM calendar_occurrences o JOIN calendar_selections cs ON cs.id = o.calendar_selection_id JOIN destination_bindings d ON d.calendar_key = cs.calendar_key JOIN event_bindings eb ON eb.binding_id = d.id JOIN plans p ON p.id = eb.plan_id WHERE o.id = ? AND eb.event_key = ? AND p.household_id = ? AND (p.visibility = 'shared' OR p.owner_id = ?) LIMIT 1`).get(row.id, indexKey(payload.providerEventId, this.key), actor.householdId, actor.memberId) as { id: string } | undefined;
      return [{ id: row.id, sourceId: row.source_id, providerEventId: payload.providerEventId, ...(payload.iCalUID ? { iCalUID: payload.iCalUID } : {}), ...(payload.originalStartTime ? { originalStartTime: payload.originalStartTime } : {}), ...(binding ? { planId: binding.id } : {}), title: payload.summary ?? 'Household event', time: payload.normalizedTime, status: row.status === 'tentative' ? 'tentative' as const : 'confirmed' as const, visibility: row.visibility === 'owner' ? 'owner' as const : 'shared' as const, generation: row.generation, sourceOwnerId: row.owner_id, ...(payload.location ? { location: payload.location } : {}) }];
    });
  }
  agenda(actor: { memberId: string; householdId: string }) { return this.agendaRows(actor).map((row) => ({ id: row.id, ownerId: row.owner_id, status: row.status, ...decryptJson<CalendarEventPayload>(JSON.parse(row.encrypted_payload), this.key, `calendar-occurrence:${row.id}`), visibility: row.visibility })); }
  agendaSafe(actor: { memberId: string; householdId: string }, window?: CalendarDateWindow) {
    const seenPlans = new Set<string>();
    return this.agendaItems(actor, window).flatMap((item) => {
      if (item.planId && seenPlans.has(item.planId)) return [];
      if (item.planId) seenPlans.add(item.planId);
      return [{ ...(item.planId ? { planId: item.planId } : {}), id: item.id, title: item.title, time: item.time, ...(item.location ? { location: item.location } : {}), status: item.status, visibility: item.visibility, origin: item.visibility === 'owner' ? 'your private calendar' as const : 'household calendar' as const }];
    });
  }
  contextItems(actor: { memberId: string; householdId: string }, window: CalendarDateWindow) {
    const seen = new Set<string>();
    return this.agendaItems(actor, window, true).flatMap((item) => {
      const identity = `${item.iCalUID ?? item.providerEventId}:${item.originalStartTime ?? ''}`;
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [item];
    });
  }
}

function calendarTimeOverlaps(time: NormalizedTime, window: CalendarDateWindow) {
  if (time.kind === 'all_day') return time.startDate < window.endDateExclusive && time.endDateExclusive > window.startDate;
  if (time.kind === 'unresolved') return Boolean(time.dateHint && time.dateHint >= window.startDate && time.dateHint < window.endDateExclusive);
  const start = time.kind === 'deadline' ? Date.parse(time.at) : Date.parse(time.start);
  if (time.kind === 'deadline') return Number.isFinite(start) && start >= Date.parse(window.startUtc) && start < Date.parse(window.endUtc);
  const end = Date.parse(time.end);
  return Number.isFinite(start) && Number.isFinite(end) && start < Date.parse(window.endUtc) && end > Date.parse(window.startUtc);
}
