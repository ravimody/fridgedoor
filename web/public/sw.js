const CACHE = 'fridgedoor-public-v2';
const OFFLINE = '/pwa/offline.html';
const PUBLIC = ['/pwa/manifest.webmanifest', OFFLINE];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PUBLIC)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (PUBLIC.includes(url.pathname)) event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  // Opening the app with no connection shows the offline page instead of the browser's error; nothing private is cached.
  else if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE).then((cached) => cached || Response.error())));
});
function safeTarget(value) {
  if (typeof value !== 'string') return '/dashboard/';
  if (value === '/dashboard/settings' || value === '/dashboard/settings/email' || value === '/dashboard/relevance-trial') return value;
  return /^\/dashboard\/(?:requests|plans)\/[a-zA-Z0-9-]{1,100}$/.test(value) ? value : '/dashboard/';
}
self.addEventListener('push', (event) => {
  let payload = {}; try { payload = event.data?.json() ?? {}; } catch { /* Display generic text for malformed pushes. */ }
  const messages = {
    'Fridgedoor morning brief': 'Open your day’s plans, to-dos and decisions in Home.',
    'Fridgedoor morning digest': 'Open your day’s plans, to-dos and decisions in Home.',
    'Fridgedoor: Teach suggestions': 'Rate your recent suggestions: Useful or Not useful. No explanation needed.',
    'Fridgedoor feedback trial': 'Rate your recent suggestions: Useful or Not useful. No explanation needed.',
    'Fridgedoor review': 'Review Home for a household update.',
    'Fridgedoor needs attention': 'A household request needs your attention.',
    'Fridgedoor: unusual email processing': 'Email analysis volume is unusually high. Open Settings to check.',
    'Fridgedoor update': 'Your household request has an update.',
  };
  const title = Object.prototype.hasOwnProperty.call(messages, payload.title) ? payload.title : 'Fridgedoor reminder';
  // The server's title names the kind of push. Older servers sent these titles; they're shown under the current names.
  const shown = { 'Fridgedoor morning digest': 'Fridgedoor morning brief', 'Fridgedoor feedback trial': 'Fridgedoor: Teach suggestions' };
  const suppliedBody = typeof payload.body === 'string' && /^(?:(?:[1-9][0-9]*) (?:calendar suggestion|list item|saved fact update|household suggestion)s?(?: and [1-9][0-9]* (?:calendar suggestion|list item|saved fact update)s?){0,2} (?:is|are) ready for review\.|(?:A planner deadline needs attention|Household coordination needs an answer|A change to household plans needs attention|An unresolved household decision needs attention) before your next morning (?:brief|review)\.|A calendar change needs attention\.|Your assistant request needs attention\.|A few household items need your attention\.|A calendar change was accepted by Google\.|Your assistant request finished processing\.|Your household requests have updates\.)$/.test(payload.body) ? payload.body : undefined;
  event.waitUntil(self.registration.showNotification(shown[title] ?? title, { body: suppliedBody ?? messages[title] ?? 'Open Home to review your household reminders.', tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 100) : 'fridgedoor-reminder', data: { url: safeTarget(payload.url) } }));
});
self.addEventListener('notificationclick', (event) => { event.notification.close(); event.waitUntil(self.clients.openWindow(safeTarget(event.notification.data?.url))); });
