import { DateTime } from 'luxon';
import type { PlanSummary } from '@fridgedoor/contracts';
type Time = PlanSummary['facts']['time'];
export function scheduleStart(time: Time, zone: string) {
  const value = time?.kind === 'deadline' ? time.at : time?.kind === 'timed' ? time.start : time?.kind === 'all_day' ? time.startDate : time?.kind === 'unresolved' ? time.startHint ?? time.dateHint : undefined;
  return value ? DateTime.fromISO(value, { zone }) : null;
}
export function inScheduleRange(time: Time, start: DateTime, end: DateTime, zone: string) {
  const from = scheduleStart(time, zone);
  if (!from?.isValid) return false;
  if (time?.kind === 'deadline' || time?.kind === 'unresolved') return from >= start && from < end;
  const to = time?.kind === 'timed' ? DateTime.fromISO(time.end) : time?.kind === 'all_day' ? DateTime.fromISO(time.endDateExclusive, { zone }) : null;
  return Boolean(to?.isValid && from < end && to > start);
}
export function scheduleLabel(time: Time, zone: string) {
  const from = scheduleStart(time, zone);
  if (time?.kind === 'deadline') return `Due ${from?.toFormat('ccc, LLL d · h:mm a')}`;
  if (time?.kind === 'timed') return `${from?.toFormat('ccc, LLL d · h:mm a')} – ${DateTime.fromISO(time.end, { zone }).toFormat('h:mm a')}`;
  if (time?.kind === 'all_day') return `${time.startDate} · All day`;
  if (time?.kind === 'unresolved' && from?.isValid) return time.startHint ? `${from.toFormat('ccc, LLL d · h:mm a')} · ${time.missing.length === 1 && time.missing[0] === 'end' ? 'End time needed' : 'Time needs review'}` : `${from.toFormat('ccc, LLL d')} · Time needs review`;
  return 'Date or time needs details';
}
