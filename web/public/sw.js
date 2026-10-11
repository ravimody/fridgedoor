/* global self, caches, URL, fetch */
const CACHE = 'fridgedoor-public-v1';
const PUBLIC = ['/pwa/manifest.webmanifest', '/pwa/offline.html'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PUBLIC)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener('fetch', (event) => { const url = new URL(event.request.url); if (event.request.method === 'GET' && url.origin === self.location.origin && PUBLIC.includes(url.pathname)) event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request))); });
function safeTarget(value) {
  if (typeof value !== 'string') return '/dashboard/';
  if (value === '/dashboard/settings' || value === '/dashboard/settings/email' || value === '/dashboard/relevance-trial') return value;
  return /^\/dashboard\/(?:requests|plans)\/[a-zA-Z0-9-]{1,100}$/.test(value) ? value : '/dashboard/';
}
self.addEventListener('push', (event) => {
  let payload = {}; try { payload = event.data?.json() ?? {}; } catch { /* Display generic text for malformed pushes. */ }
  const messages = {
    'Fridgedoor morning digest': 'Open your day’s plans, to-dos and decisions in Home.',
    'Fridgedoor feedback trial': 'Rate your recent suggestions: Useful or Not useful. No explanation needed.',
    'Fridgedoor review': 'Review Home for a household update.',
    'Fridgedoor needs attention': 'A household request needs your attention.',
    'Fridgedoor: unusual email processing': 'Email analysis volume is unusually high. Open Settings to check.',
    'Fridgedoor update': 'Your household request has an update.',
  };
  const title = Object.prototype.hasOwnProperty.call(messages, payload.title) ? payload.title : 'Fridgedoor reminder';
  const suppliedBody = typeof payload.body === 'string' && /^(?:(?:[1-9][0-9]*) (?:calendar suggestion|list item|saved fact update|household suggestion)s?(?: and [1-9][0-9]* (?:calendar suggestion|list item|saved fact update)s?){0,2} (?:is|are) ready for review\.|A planner deadline needs attention before your next morning review\.|Household coordination needs an answer before your next morning review\.|A change to household plans needs attention before your next morning review\.|An unresolved household decision needs attention before your next morning review\.|A calendar change needs attention\.|Your assistant request needs attention\.|A calendar change was accepted by Google\.|Your assistant request finished processing\.)$/.test(payload.body) ? payload.body : undefined;
  event.waitUntil(self.registration.showNotification(title, { body: suppliedBody ?? messages[title] ?? 'Open Home to review your household reminders.', tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 100) : 'fridgedoor-reminder', data: { url: safeTarget(payload.url) } }));
});
self.addEventListener('notificationclick', (event) => { event.notification.close(); event.waitUntil(self.clients.openWindow(safeTarget(event.notification.data?.url))); });
