import { randomBytes } from 'node:crypto';
import webpush from 'web-push';
import type { AppConfig } from './config.js';
import type { SettingsStore } from './settings.js';

/**
 * Fills in what a fresh install hasn't been told: the public address recorded during
 * setup, Web Push keys (generated once and saved), Google OAuth credentials saved in
 * the web app, and the one-time setup token. Environment variables always win.
 */
export function prepareRuntime(config: AppConfig, settings: SettingsStore, needsSetup: boolean) {
  if (!config.ORIGIN_FROM_ENV) { const saved = settings.get('public_url'); if (saved) config.APP_ORIGIN = new URL(saved).origin; }
  if (config.PUSH_PROVIDER !== 'fake') {
    if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) {
      const saved = settings.get('vapid') ?? (() => { const keys = webpush.generateVAPIDKeys(); const value = { publicKey: keys.publicKey, privateKey: keys.privateKey }; settings.set('vapid', value); return value; })();
      config.VAPID_PUBLIC_KEY = saved.publicKey; config.VAPID_PRIVATE_KEY = saved.privateKey;
    }
    // Push services require a contact: an https URL or a mailto address.
    config.VAPID_SUBJECT ??= config.APP_ORIGIN.startsWith('https:') ? config.APP_ORIGIN : 'mailto:fridgedoor@localhost';
    config.PUSH_PROVIDER = 'webpush';
  }
  if (!config.GOOGLE_CLIENT_ID) { const google = settings.get('google_oauth'); if (google) { config.GOOGLE_CLIENT_ID = google.clientId; config.GOOGLE_CLIENT_SECRET = google.clientSecret; } }
  if (needsSetup && !config.SETUP_TOKEN && !settings.get('setup_token')) settings.set('setup_token', randomBytes(18).toString('base64url'));
}

export function setupLink(config: AppConfig, settings: SettingsStore) {
  const token = config.SETUP_TOKEN ?? settings.get('setup_token') ?? '';
  return `${config.APP_ORIGIN}/dashboard/setup?token=${encodeURIComponent(token)}`;
}
