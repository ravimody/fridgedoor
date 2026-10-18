import { authStatusSchema, sessionResponseSchema, type AuthStatus, type Member } from '@fridgedoor/contracts';

export const API_BASE = '/dashboard/api/v1';
let csrfToken: string | undefined;
let generation = 0;
export const getSessionGeneration = () => generation;
export const clearClientSession = () => { csrfToken = undefined; generation += 1; };

async function jsonResponse(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new Error('AUTH_REQUIRED');
  return response.json();
}

export async function bootstrap(origin = window.location.origin): Promise<Member> {
  if (import.meta.env.DEV && import.meta.env.VITE_SYNTHETIC_AUTH === '1') {
    csrfToken = 'synthetic-local-preview-csrf-token-012345678901234567890123';
    return { id: 'synthetic-alex', householdId: 'synthetic-household', displayName: 'Alex (preview)', timezone: 'America/New_York' };
  }
  const response = await fetch(`${API_BASE}/session`, { method: 'POST', credentials: 'include', headers: { Accept: 'application/json', Origin: origin, 'X-Fridgedoor-Bootstrap': '1' } });
  const parsed = sessionResponseSchema.parse(await jsonResponse(response));
  csrfToken = parsed.data.csrfToken;
  return parsed.data.member;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (method !== 'GET' && method !== 'HEAD') { headers.set('Origin', window.location.origin); if (csrfToken) headers.set('X-CSRF-Token', csrfToken); }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });
  // Only a missing or expired session (401) means signing in again. A 403 (FORBIDDEN: an owner-only page, or a
  // failed origin/CSRF check) is an ordinary error, so it never signs anyone out.
  if (response.status === 401) { clearClientSession(); throw new Error('AUTH_REQUIRED'); }
  if (!response.ok) throw new Error((await errorCode(response)) ?? `API_${response.status}`);
  return (await jsonResponse(response)) as T;
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = await response.json().catch(() => undefined) as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}

/** Calls the public sign-in endpoints, which work without a session. Errors are thrown as their server code. */
export async function publicFetch<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'include',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error((await errorCode(response)) ?? `API_${response.status}`);
  return (await jsonResponse(response)) as T;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  return authStatusSchema.parse(await publicFetch('/auth/status')).data;
}

/** Setup, sign-in and joining an invite all set the session cookie and return the member plus a CSRF token. */
export async function startSession(path: '/auth/setup' | '/auth/login' | `/auth/invites/${string}`, body: unknown): Promise<Member> {
  const parsed = sessionResponseSchema.parse(await publicFetch(path, body));
  clearClientSession();
  csrfToken = parsed.data.csrfToken;
  return parsed.data.member;
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/session`, { method: 'DELETE', credentials: 'include', headers: { Accept: 'application/json', Origin: window.location.origin, ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) } });
  } finally { clearClientSession(); }
}
