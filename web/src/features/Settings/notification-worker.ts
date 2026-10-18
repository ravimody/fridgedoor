export const NOTIFICATION_WORKER_URL = '/pwa/sw.js?v=4';
export function registerNotificationWorker() {
  return navigator.serviceWorker.register(NOTIFICATION_WORKER_URL, { scope: '/dashboard/' });
}
