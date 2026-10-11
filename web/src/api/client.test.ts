import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch, startSession } from './client.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); });

it('keeps the CSRF token from sign-in for later changes', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(json(200, { data: { member: { id: 'm1', householdId: 'h1', displayName: 'Alex', timezone: 'UTC' }, csrfToken: 'c'.repeat(43) } }))
    .mockResolvedValueOnce(json(200, { data: { saved: true } }));
  vi.stubGlobal('fetch', fetchMock);
  expect(await startSession('/auth/login', { email: 'alex@example.test', password: 'long enough' })).toMatchObject({ displayName: 'Alex' });
  expect(fetchMock.mock.calls[0]![0]).toBe('/dashboard/api/v1/auth/login');
  await apiFetch('/household', { method: 'PATCH', body: '{}' });
  expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toBeInstanceOf(Headers);
  expect(((fetchMock.mock.calls[1]![1] as RequestInit).headers as Headers).get('X-CSRF-Token')).toBe('c'.repeat(43));
});

it('reports sign-in errors by code without treating them as an expired session', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, { error: { code: 'SIGN_IN_FAILED', message: 'sign in failed', requestId: 'r' } })));
  await expect(startSession('/auth/login', { email: 'a@b.c', password: 'x' })).rejects.toThrow('SIGN_IN_FAILED');
});

it('treats a plain 403 as an expired session but passes specific codes through', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(403, { error: { code: 'PASSWORD_INCORRECT', message: 'x', requestId: 'r' } })).mockResolvedValueOnce(json(403, { error: { code: 'FORBIDDEN', message: 'x', requestId: 'r' } })));
  await expect(apiFetch('/account/password', { method: 'POST' })).rejects.toThrow('PASSWORD_INCORRECT');
  await expect(apiFetch('/household', { method: 'PATCH' })).rejects.toThrow('AUTH_REQUIRED');
});
