import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client.js';

type Policy = { excludedSenders: string[]; excludedLabels: string[]; genericAppointmentOptIn: boolean; revision: number };
const list = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);

/** Senders and labels this person's email is filtered by before anything is shared. */
export function EmailPrivacy() {
  const [policy, setPolicy] = useState<Policy>({ excludedSenders: [], excludedLabels: [], genericAppointmentOptIn: false, revision: 1 });
  const [notice, setNotice] = useState('');
  useEffect(() => { void apiFetch<{ data: Policy }>('/source-policy').then((nextPolicy) => setPolicy(nextPolicy.data)).catch(() => setNotice('Settings are unavailable until your secure session is active.')); }, []);
  async function savePolicy() { try { const response = await apiFetch<{ data: Policy }>('/source-policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...policy, expectedRevision: policy.revision }) }); setPolicy(response.data); setNotice('Source preferences saved.'); } catch { setNotice('Source preferences could not be saved.'); } }
  return <section className="card settings-card"><h2>Email privacy</h2><p>Excluded senders and labels stay private to your account. Work sources remain excluded from automatic household sharing.</p>
    {notice && <p role="status" className="notice">{notice}</p>}
    <label>Excluded senders<input value={policy.excludedSenders.join(', ')} onChange={(event) => setPolicy({ ...policy, excludedSenders: list(event.target.value) })} placeholder="news@example.com" /></label>
    <label>Excluded labels<input value={policy.excludedLabels.join(', ')} onChange={(event) => setPolicy({ ...policy, excludedLabels: list(event.target.value) })} placeholder="Receipts" /></label>
    <label className="checkbox"><input type="checkbox" checked={policy.genericAppointmentOptIn} onChange={(event) => setPolicy({ ...policy, genericAppointmentOptIn: event.target.checked })} /> Share generic appointment logistics when I explicitly opt in</label>
    <button onClick={() => void savePolicy()}>Save source preferences</button>
  </section>;
}

/** What is shared, retained and sent to AI. Sits under the email suggestions card it refers to. */
export function PrivacyDisclosure() {
  return <section className="card settings-card"><h2>Privacy disclosure</h2><p>Household suggestions share only permitted logistics and facts; the source email and private evidence stay with you. Work calendars, private or uncertain items, and excluded sources remain owner-only. Medical sources stay private unless you opt into generic appointment logistics, without diagnosis or provider details.</p><p>Encrypted source email and private extraction data are retained for up to 7 days, private chat for up to 30 days, and uploaded photos or PDFs for up to 24 hours after successful extraction. Shared plans and calendar bindings remain until the household deletes them. The server operator can access decrypted processing data.</p><p>Email suggestions above control background AI for your account separately from Google sync and the interactive assistant. Hosted AI can retain submitted content under its provider policy; this is not a zero-retention service. Most providers keep API data for a limited time for abuse monitoring under their own policy. AI never receives sign-in tokens or authority to write calendars.</p></section>;
}
