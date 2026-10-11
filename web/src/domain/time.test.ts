import { describe, expect, it } from 'vitest';
import { formatTime, shiftForDisplay } from './time.js';

describe('calendar display time', () => {
  it('formats all-day dates without converting through UTC', () => { expect(formatTime({ kind: 'all_day', startDate: '2026-11-01', endDateExclusive: '2026-11-02' }, 'America/New_York')).toBe('2026-11-01–2026-11-02'); });
  it('shifts a timed event for the viewer while preserving its instant', () => { const shifted = shiftForDisplay({ kind: 'timed', start: '2026-03-08T09:00:00-04:00', end: '2026-03-08T10:00:00-04:00', timezone: 'America/New_York' }, 'America/Los_Angeles'); expect(shifted.kind === 'timed' && shifted.start).toContain('-07:00'); });
});

it('shows a deadline as a due instant in the viewer timezone', () => {
  const deadline = { kind: 'deadline' as const, at: '2026-09-18T17:00:00-04:00', timezone: 'America/New_York' };
  expect(formatTime(deadline, 'America/Los_Angeles')).toBe('Due Fri, Sep 18, 2:00 PM');
  expect(shiftForDisplay(deadline, 'America/Los_Angeles')).toEqual({ ...deadline, at: '2026-09-18T14:00:00-07:00' });
});
