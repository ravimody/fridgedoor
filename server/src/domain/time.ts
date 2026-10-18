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
