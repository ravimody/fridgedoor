import { DateTime } from 'luxon';
import { normalizedTimeSchema, type NormalizedTime } from '@fridgedoor/contracts';

export type GoogleDateTime = { date?: string; dateTime?: string; timeZone?: string };
export function normalizeGoogleTime(start: GoogleDateTime | undefined, end: GoogleDateTime | undefined): NormalizedTime {
  if (start?.date && end?.date) return normalizedTimeSchema.parse({ kind: 'all_day', startDate: start.date, endDateExclusive: end.date });
  const missing: Array<'date'|'start'|'end'|'timezone'> = [];
  if (!start?.dateTime) missing.push('start'); if (!end?.dateTime) missing.push('end');
  if (missing.length) return { kind: 'unresolved', ...(start?.date ? { dateHint: start.date } : {}), missing };
  const startDateTime = start?.dateTime; const endDateTime = end?.dateTime; if (!startDateTime || !endDateTime) return { kind: 'unresolved', ...(start?.date ? { dateHint: start.date } : {}), missing };
  const startValue = DateTime.fromISO(startDateTime, { setZone: true }); const endValue = DateTime.fromISO(endDateTime, { setZone: true });
  if (!startValue.isValid || !endValue.isValid) return { kind: 'unresolved', missing: ['timezone'] };
  const timezone = start?.timeZone ?? end?.timeZone ?? startValue.zoneName;
  if (!timezone || !DateTime.local().setZone(timezone).isValid || endValue.toMillis() <= startValue.toMillis()) return { kind: 'unresolved', missing: ['timezone', ...(endValue.toMillis() <= startValue.toMillis() ? ['end' as const] : [])] };
  const startIso = startValue.toISO({ suppressMilliseconds: true }); const endIso = endValue.toISO({ suppressMilliseconds: true }); if (!startIso || !endIso) return { kind: 'unresolved', missing: ['timezone'] };
  return normalizedTimeSchema.parse({ kind: 'timed', start: startIso, end: endIso, timezone });
}
export function displayTime(time: NormalizedTime, timezone: string): NormalizedTime {
  if (time.kind === 'deadline') {
    const at = DateTime.fromISO(time.at).setZone(timezone).toISO({ suppressMilliseconds: true });
    return at ? normalizedTimeSchema.parse({ ...time, at }) : time;
  }
  if (time.kind !== 'timed') return time;
  const zone = DateTime.local().setZone(timezone); if (!zone.isValid) return time;
  const start = DateTime.fromISO(time.start).setZone(timezone).toISO({ suppressMilliseconds: true }); const end = DateTime.fromISO(time.end).setZone(timezone).toISO({ suppressMilliseconds: true }); if (!start || !end) return time;
  return normalizedTimeSchema.parse({ ...time, start, end });
}
