import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
import webpush from 'web-push';
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { prepareRuntime } from '../runtime.js';
import { SettingsStore } from '../settings.js';
import { FakePushProvider, WebPushProvider, createPushProvider, validatePushEndpoint } from './push.js';

describe('push provider configuration', () => {
  it('uses the fake provider until real delivery is prepared', () => {
    expect(createPushProvider(loadConfig({ NODE_ENV: 'test' }))).toBeInstanceOf(FakePushProvider);
    expect(createPushProvider(loadConfig({ NODE_ENV: 'test', PUSH_PROVIDER: 'fake' }))).toBeInstanceOf(FakePushProvider);
  });

  it('generates Web Push keys once and keeps them across restarts', () => {
    const db = new Database(':memory:'); migrate(db);
    const settings = new SettingsStore(db, 'test-session-secret-change-me-1234567890');
    const first = loadConfig({ NODE_ENV: 'test' }); prepareRuntime(first, settings, false);
    expect(first.PUSH_PROVIDER).toBe('webpush'); expect(first.VAPID_SUBJECT).toBe('mailto:fridgedoor@localhost');
    expect(createPushProvider(first)).toBeInstanceOf(WebPushProvider);
    const second = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'https://fridgedoor.example.test' }); prepareRuntime(second, settings, false);
    expect(second.VAPID_PUBLIC_KEY).toBe(first.VAPID_PUBLIC_KEY); expect(second.VAPID_SUBJECT).toBe('https://fridgedoor.example.test');
  });

  it('requires all VAPID settings for real delivery', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', PUSH_PROVIDER: 'webpush', VAPID_PUBLIC_KEY: 'public' })).toThrow(/VAPID/);
    const keys = webpush.generateVAPIDKeys();
    const config = loadConfig({ NODE_ENV: 'test', PUSH_PROVIDER: 'webpush', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:planner@example.test' });
    expect(createPushProvider(config)).toBeInstanceOf(WebPushProvider);
  });

  it('accepts only the documented public push endpoint shapes', () => {
    expect(validatePushEndpoint('https://updates.push.services.mozilla.com/push/v1/test')).toContain('https://');
    expect(() => validatePushEndpoint('http://updates.push.services.mozilla.com/push/v1/test')).toThrow('INVALID_PUSH_ENDPOINT');
    expect(() => validatePushEndpoint('https://example.test/push')).toThrow('INVALID_PUSH_ENDPOINT');
  });
});

it('accepts public IPv6 delivery hosts and supplies a valid bounded Web Push topic', async () => {
  vi.mocked(lookup).mockResolvedValue([{ address: '2606:4700::1111', family: 6 }] as never);
  const vapid = webpush.generateVAPIDKeys(); const client = webpush.generateVAPIDKeys();
  const send = vi.spyOn(webpush, 'sendNotification').mockImplementation(async (subscription, payload, options) => {
    const request = webpush.generateRequestDetails(subscription, payload ?? undefined, options);
    expect(request.headers.Topic).toMatch(/^[0-9a-f]{32}$/);
    return { statusCode: 201, body: '', headers: {} };
  });
  const provider = new WebPushProvider(vapid.publicKey, vapid.privateKey, 'mailto:planner@example.test');
  const result = await provider.send({ id: 's', endpoint: 'https://web.push.apple.com/synthetic', p256dh: client.publicKey, auth: Buffer.alloc(16).toString('base64url'), label: 'Test' }, { title: 'Fridgedoor reminder', url: '/dashboard/', tag: 'reminder-' + 'a'.repeat(32) + '-1' }, 300);
  expect(result).toBe('accepted'); expect(send).toHaveBeenCalledTimes(1);
});
