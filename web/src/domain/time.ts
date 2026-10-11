import { DateTime } from 'luxon';
import { normalizedTimeSchema, type NormalizedTime } from '@fridgedoor/contracts';

export function formatTime(time: NormalizedTime, timezone: string) {
  if (time.kind === 'deadline') return `Due ${DateTime.fromISO(time.at).setZone(timezone).toFormat('ccc, LLL d, h:mm a')}`;
  if (time.kind === 'all_day') return `${time.startDate}–${time.endDateExclusive}`;
  if (time.kind === 'unresolved') return time.dateHint ? `Date to confirm: ${time.dateHint}` : 'Time to confirm';
  const start = DateTime.fromISO(time.start).setZone(timezone); const end = DateTime.fromISO(time.end).setZone(timezone);
  return `${start.toFormat('ccc, LLL d, h:mm a')}–${end.toFormat('h:mm a')}`;
}
export function shiftForDisplay(time: NormalizedTime, timezone: string): NormalizedTime {
  if (time.kind === 'deadline') {
    const at = DateTime.fromISO(time.at).setZone(timezone).toISO({ suppressMilliseconds: true });
    return at ? normalizedTimeSchema.parse({ ...time, at }) : time;
  }
  if (time.kind !== 'timed') return time;
  const start = DateTime.fromISO(time.start).setZone(timezone).toISO({ suppressMilliseconds: true }); const end = DateTime.fromISO(time.end).setZone(timezone).toISO({ suppressMilliseconds: true }); if (!start || !end) return time;
  return normalizedTimeSchema.parse({ ...time, start, end });
}
