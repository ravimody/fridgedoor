import { afterEach, expect, it, vi } from 'vitest';
import { GoogleApiProvider, type GoogleEventWrite, type GoogleGrant } from './google.js';

const grant: GoogleGrant = { sub: 'g', email: 'owner@example.test', scopes: [], accessToken: 'access', refreshToken: 'refresh', expiresAt: '2030-01-01T00:00:00Z' };
const input: GoogleEventWrite = { summary: 'School pickup', description: 'Fridgedoor action a1', start: { dateTime: '2026-01-02T15:00:00-05:00' }, end: { dateTime: '2026-01-02T16:00:00-05:00' } };
afterEach(() => vi.unstubAllGlobals());
it('inserts with POST and the deterministic base32hex event id', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'abcde', ...input })); vi.stubGlobal('fetch', fetch);
  await new GoogleApiProvider('client', 'secret').createCalendarEvent(grant, 'household', 'abcde', input);
  const [url, options] = fetch.mock.calls[0]!;
  expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/household/events'); expect(options.method).toBe('POST');
  expect(JSON.parse(options.body)).toEqual({ ...input, id: 'abcde' });
});
it('patches only planner fields with an etag precondition', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ id: 'abcde', ...input })); vi.stubGlobal('fetch', request);
  await new GoogleApiProvider('client', 'secret').updateCalendarEvent(grant, 'household', 'abcde', input, 'previous-etag');
  const [, options] = request.mock.calls[0]!;
  expect(options.method).toBe('PATCH'); expect(options.headers['If-Match']).toBe('previous-etag');
  expect(JSON.parse(options.body)).toEqual(input);
});
