import { expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { inScheduleRange, scheduleLabel } from './schedule-time.js';
const zone = 'America/New_York';
const start = DateTime.fromISO('2026-09-13', { zone }); const end = start.plus({ days: 7 });
it('uses local dates and exclusive range ends for partial starts and date hints', () => {
  expect(inScheduleRange({ kind: 'unresolved', startHint: '2026-09-20T03:30:00Z', missing: ['end'] }, start, end, zone)).toBe(true);
  expect(inScheduleRange({ kind: 'unresolved', startHint: '2026-09-20T04:00:00Z', missing: ['end'] }, start, end, zone)).toBe(false);
  expect(inScheduleRange({ kind: 'unresolved', dateHint: '2026-09-14', missing: ['start', 'end'] }, start, end, zone)).toBe(true);
  expect(inScheduleRange({ kind: 'unresolved', missing: ['date'] }, start, end, zone)).toBe(false);
  expect(scheduleLabel({ kind: 'unresolved', dateHint: '2026-09-14', missing: ['start', 'end'] }, zone)).toContain('Time needs review');
});
it('preserves ongoing interval and deadline inclusion', () => {
  expect(inScheduleRange({ kind: 'timed', start: '2026-09-12T23:00:00-04:00', end: '2026-09-13T01:00:00-04:00', timezone: zone }, start, end, zone)).toBe(true);
  expect(inScheduleRange({ kind: 'deadline', at: '2026-09-14T17:00:00-04:00', timezone: zone }, start, end, zone)).toBe(true);
});
