import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client.js';
import { registerNotificationWorker } from './notification-worker.js';
type Subscription = { id: string; label: string; status: 'enabled'|'disabled'; endpointHash: string };
type Config = { enabled: boolean; publicKey: string | null };
async function hashEndpoint(endpoint: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}
async function readyWorker() {
  await registerNotificationWorker();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('WORKER_TIMEOUT')), 20000); })]);
  } finally { clearTimeout(timer); }
}
export function Notifications() {
  const [config, setConfig] = useState<Config>();
  const [deviceId, setDeviceId] = useState<string>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  useEffect(() => {
    let active = true;
    void Promise.all([
      apiFetch<{ data: Config }>('/push-config'),
      apiFetch<{ data: { subscriptions?: Subscription[] } }>('/push-subscriptions'),
      supported ? navigator.serviceWorker.getRegistration('/dashboard/').then((registration) => registration?.pushManager.getSubscription()) : undefined,
    ]).then(async ([settings, saved, local]) => {
      const hash = local ? await hashEndpoint(local.endpoint) : undefined;
      if (!active) return;
      setConfig(settings.data);
      setDeviceId(hash && Notification.permission === 'granted' ? saved.data.subscriptions?.find((item) => item.endpointHash === hash && item.status === 'enabled')?.id : undefined);
      setChecked(true);
    }).catch(() => { if (active) { setNotice('Could not check notification settings. Reload to try again.'); setChecked(true); } });
    return () => { active = false; };
  }, [supported]);
  async function enable() {
    if (busy || !supported || !config?.enabled || !config.publicKey) return;
    setBusy(true);
    setNotice('');
    try {
      // Keep the permission prompt in the button's user gesture, before any network await.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setNotice('Notification permission was not granted. You can still use in-app reminders.'); return; }
      const registration = await readyWorker();
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: config.publicKey });
      const result = await apiFetch<{ data: { id: string } }>('/push-subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint, keys: { p256dh: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('p256dh')!))), auth: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('auth')!))) }, label: 'This phone' }) });
      setDeviceId(result.data.id);
      setNotice('This phone is enrolled. Send a test to check delivery.');
    } catch { setNotice('This phone could not be enrolled. Reopen the Home Screen app and try again.'); }
    finally { setBusy(false); }
  }
  async function testDelivery() {
    if (!deviceId) return;
    setBusy(true);
    try {
      const result = await apiFetch<{ data: { state: string } }>(`/push-subscriptions/${deviceId}/test`, { method: 'POST' });
      setNotice(result.data.state === 'accepted' ? 'Test accepted by the delivery service. Check this phone for the notification.' : 'The test could not be delivered. Try enabling this phone again.');
      if (result.data.state === 'gone') setDeviceId(undefined);
    } catch { setNotice('Could not send the test. Try again.'); }
    finally { setBusy(false); }
  }
  return <section className="card settings-card"><h2>Phone notifications</h2>
    <p>On iPhone, open the planner in Safari, choose Share → Add to Home Screen, then open that icon and enable notifications here. Each phone enrolls separately.</p>
    <p>Get grouped alerts when requests need review or fail. Completed updates notify you when you are away from the app. Lock-screen text stays generic; details load after sign-in.</p>
    {notice && <p role="status" className="notice">{notice}</p>}
    <p>{!checked ? 'Checking this phone…' : !supported ? 'Open the Home Screen app to enable notifications on iPhone. This browser does not offer Web Push.' : !config ? 'Notification settings are unavailable.' : !config.enabled || !config.publicKey ? 'Phone delivery is not configured on the server yet.' : deviceId ? 'Notifications are enabled on this phone.' : 'Phone delivery is available. This phone is not enrolled for your account.'}</p>
    <button disabled={busy || !supported || !checked || !config?.enabled || !config.publicKey} onClick={() => void enable()}>{busy ? 'Working…' : deviceId ? 'Re-enable this phone' : 'Enable notifications'}</button>
    {deviceId && <button className="secondary" disabled={busy} onClick={() => void testDelivery()}>Send test notification</button>}
  </section>;
}
