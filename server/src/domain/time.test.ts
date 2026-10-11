import { describe, expect, it } from 'vitest';
import { normalizeGoogleTime } from './time.js';

describe('normalized calendar time', () => {
  it('keeps all-day end dates exclusive', () => { expect(normalizeGoogleTime({ date: '2026-03-08' }, { date: '2026-03-09' })).toEqual({ kind: 'all_day', startDate: '2026-03-08', endDateExclusive: '2026-03-09' }); });
  it('does not invent an end time', () => { expect(normalizeGoogleTime({ dateTime: '2026-03-08T09:00:00-05:00', timeZone: 'America/New_York' }, undefined)).toEqual({ kind: 'unresolved', missing: ['end'] }); });
  it('retains offsets across a DST boundary', () => { const value = normalizeGoogleTime({ dateTime: '2026-03-08T01:30:00-05:00', timeZone: 'America/New_York' }, { dateTime: '2026-03-08T04:00:00-04:00', timeZone: 'America/New_York' }); expect(value.kind).toBe('timed'); if (value.kind === 'timed') { expect(value.start).toContain('-05:00'); expect(value.end).toContain('-04:00'); } });
});
