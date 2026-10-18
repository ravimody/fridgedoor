import { digest } from '../crypto.js';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import webpush from 'web-push';
import type { AppConfig } from '../config.js';

export type PushSubscription = { id: string; endpoint: string; p256dh: string; auth: string; label: string };
export type PushPayload = { title: 'Fridgedoor: Teach suggestions' | 'Fridgedoor reminder' | 'Fridgedoor morning brief' | 'Fridgedoor review' | 'Fridgedoor needs attention' | 'Fridgedoor update' | 'Fridgedoor: unusual email processing'; body?: string; url: string; tag: string };
export type PushProvider = { send(subscription: PushSubscription, payload: PushPayload, ttlSeconds: number): Promise<'accepted'|'gone'|'retry'> };
export class FakePushProvider implements PushProvider {
  readonly sent: Array<{ subscriptionId: string; payload: PushPayload }> = [];
  async send(subscription: PushSubscription, payload: PushPayload) { this.sent.push({ subscriptionId: subscription.id, payload }); return 'accepted' as const; }
}
export class WebPushProvider implements PushProvider {
  constructor(publicKey: string, privateKey: string, subject: string) { webpush.setVapidDetails(subject, publicKey, privateKey); }
  async send(subscription: PushSubscription, payload: PushPayload, ttlSeconds: number) {
    let dnsTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([assertPublicPushHost(subscription.endpoint), new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error('PUSH_DNS_TIMEOUT')), 5000); })]); } finally { clearTimeout(dnsTimer); }
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload), { TTL: ttlSeconds, topic: digest(payload.tag).slice(0, 32), timeout: 15000 });
      return 'accepted' as const;
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
      if (statusCode === 404 || statusCode === 410) return 'gone' as const;
      return 'retry' as const;
    }
  }
}
export function createPushProvider(config: AppConfig): PushProvider { return config.PUSH_PROVIDER === 'webpush' ? new WebPushProvider(config.VAPID_PUBLIC_KEY!, config.VAPID_PRIVATE_KEY!, config.VAPID_SUBJECT!) : new FakePushProvider(); }
const allowedHosts = [/\.push\.services\.mozilla\.com$/i, /\.push\.apple\.com$/i, /^web\.push\.apple\.com$/i, /^fcm\.googleapis\.com$/i];
export function validatePushEndpoint(endpoint: string) { let url: URL; try { url = new URL(endpoint); } catch { throw new Error('INVALID_PUSH_ENDPOINT'); } if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || url.search || url.hash || !allowedHosts.some((pattern) => pattern.test(url.hostname))) throw new Error('INVALID_PUSH_ENDPOINT'); if (url.hostname === 'localhost' || /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname) || url.hostname === '::1') throw new Error('INVALID_PUSH_ENDPOINT'); return url.toString(); }
async function assertPublicPushHost(endpoint: string) { const url = new URL(validatePushEndpoint(endpoint)); const addresses = await lookup(url.hostname, { all: true, verbatim: true }); if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('INVALID_PUSH_ENDPOINT'); }
function isPrivateAddress(address: string) { const lower = address.toLowerCase(); if (isIP(address) === 6) return !/^[23][0-9a-f]{3}:/.test(lower) || lower.startsWith('2001:db8:'); if (lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:') || lower.startsWith('ff')) return true; const octets = address.split('.').map(Number); if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true; const a = octets[0] ?? -1; const b = octets[1] ?? -1; return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 192 && b === 0 || a === 198 && (b === 18 || b === 19) || a >= 224;
}
export const endpointHash = (endpoint: string) => digest(endpoint);
