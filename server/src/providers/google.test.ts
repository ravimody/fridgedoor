import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoogleProvider, GoogleApiProvider, GOOGLE_SCOPES, UnconfiguredGoogleProvider, type GoogleGrant } from './google.js';

describe('Google provider configuration', () => {
  it('fails closed instead of sending a fake OAuth client to Google', () => {
    const provider = createGoogleProvider();
    expect(provider).toBeInstanceOf(UnconfiguredGoogleProvider);
    expect(() => provider.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri: 'https://planner.example.test/callback' })).toThrow('GOOGLE_NOT_CONFIGURED');
  });

  it('rejects a partial live OAuth configuration', () => {
    expect(() => createGoogleProvider('client-id')).toThrow('GOOGLE_CLIENT_CONFIGURATION_INCOMPLETE');
  });
});

const grant: GoogleGrant = { sub: 'synthetic-subject', email: 'owner@example.test',
  scopes: [...GOOGLE_SCOPES], accessToken: 'expired-access', refreshToken: 'synthetic-refresh', expiresAt: '2020-01-01T00:00:00Z' };
const provider = () => new GoogleApiProvider('synthetic-client', 'synthetic-secret');
const success = { access_token: 'new-access', token_type: 'Bearer', expires_in: 3600 };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Google offline token exchange', () => {
  it('refreshes using a form POST and preserves the owner and omitted refresh token', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetch = vi.fn().mockResolvedValue(Response.json(success)); vi.stubGlobal('fetch', fetch);
    const refreshed = await provider().refresh(grant);
    expect(refreshed).toEqual({ ...grant, accessToken: 'new-access', expiresAt: '2026-01-01T01:00:00.000Z' });
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(options.method).toBe('POST');
    expect(Object.fromEntries(options.body)).toEqual({ client_id: 'synthetic-client', client_secret: 'synthetic-secret', refresh_token: 'synthetic-refresh', grant_type: 'refresh_token' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(grant.accessToken).toBe('expired-access');
  });
  it('accepts a rotated refresh token and equivalent email scope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...success, refresh_token: 'rotated',
      scope: grant.scopes.map((scope) => scope === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : scope).join(' ') })));
    expect((await provider().refresh(grant)).refreshToken).toBe('rotated');
  });
  it.each([['openid email'], [[...GOOGLE_SCOPES, 'https://www.googleapis.com/auth/gmail.send'].join(' ')]])('requires consent again for changed scopes', async (scope) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...success, scope })));
    await expect(provider().refresh(grant)).rejects.toThrow('GOOGLE_REAUTH_REQUIRED');
  });
  it('requires reconnect for a revoked grant without exposing provider details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'invalid_grant', error_description: 'private detail' }, { status: 400 })));
    await expect(provider().refresh(grant)).rejects.toThrow(/^GOOGLE_REAUTH_REQUIRED$/);
  });
  it('does not treat provider outages as revoked consent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'server_error' }, { status: 503 })));
    await expect(provider().refresh(grant)).rejects.toThrow(/^GOOGLE_REFRESH_FAILED$/);
  });
  it('sanitizes network failures and rejects missing offline credentials without a request', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('sensitive upstream detail')); vi.stubGlobal('fetch', fetch);
    const withoutRefresh = { ...grant }; delete withoutRefresh.refreshToken;
    await expect(provider().refresh(withoutRefresh)).rejects.toThrow('GOOGLE_REAUTH_REQUIRED');
    expect(fetch).not.toHaveBeenCalled();
    await expect(provider().refresh(grant)).rejects.toThrow(/^GOOGLE_REFRESH_FAILED$/);
  });
  it.each([{ ...success, expires_in: -1 }, { ...success, access_token: '' }, { ...success, token_type: 'Unknown' }])('rejects malformed successful responses', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    await expect(provider().refresh(grant)).rejects.toThrow('GOOGLE_REFRESH_FAILED');
  });
});

it('requests Inbox history including label changes for messages moved into Inbox', async () => {
  const fetch=vi.fn().mockResolvedValue(Response.json({history:[],historyId:'12'}));vi.stubGlobal('fetch',fetch);
  await provider().listGmailHistory(grant,{startHistoryId:'10'});
  const url=new URL(String(fetch.mock.calls[0]?.[0]));
  expect(url.searchParams.get('labelId')).toBe('INBOX');
  expect(url.searchParams.has('historyTypes')).toBe(false);
});
