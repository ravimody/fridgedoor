import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { normalizedTimeSchema } from '@fridgedoor/contracts';
export function calendarStatus(db: Database.Database, selectionId: string, generation: number, zone: string, now: Date) {
  const state = db.prepare("SELECT last_success_at, error_code FROM sync_states WHERE source_kind = 'calendar' AND stream_key = ? AND generation = ?").get(selectionId, generation) as { last_success_at: string | null; error_code: string | null } | undefined;
  const rows = db.prepare("SELECT normalized_time_json FROM calendar_occurrences WHERE calendar_selection_id = ? AND generation = ? AND status IN ('confirmed','tentative') AND expires_at > ?").all(selectionId, generation, now.toISOString()) as { normalized_time_json: string }[];
  const start = DateTime.fromJSDate(now).setZone(zone).startOf('day'); const end = start.plus({ days: 7 });
  const upcoming = rows.filter((row) => {
    const time = normalizedTimeSchema.parse(JSON.parse(row.normalized_time_json));
    const from = time.kind === 'timed' ? DateTime.fromISO(time.start) : time.kind === 'all_day' ? DateTime.fromISO(time.startDate, { zone }) : null;
    const to = time.kind === 'timed' ? DateTime.fromISO(time.end) : time.kind === 'all_day' ? DateTime.fromISO(time.endDateExclusive, { zone }) : null;
    return from && to && from < end && to > start;
  }).length;
  // Provider errors can include private response text; expose only actionable categories.
  const error = !state?.error_code ? null : state.error_code === 'GOOGLE_CALENDAR_SYNC_EXPIRED' ? 'resyncing' : ['GOOGLE_INVALID_GRANT','GOOGLE_REAUTH_REQUIRED'].includes(state.error_code) ? 'reconnect' : 'retrying';
  return { lastSuccessAt: state?.last_success_at ?? null, error, stale: Boolean(state?.last_success_at && now.getTime() - Date.parse(state.last_success_at) > 10 * 60000), imported: rows.length, upcoming };
}
