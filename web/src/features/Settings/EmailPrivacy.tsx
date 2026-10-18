import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client.js';

type Policy = { excludedSenders: string[]; excludedLabels: string[]; genericAppointmentOptIn: boolean; revision: number };
const list = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);

/** Senders and labels this person's email is filtered by before anything is shared. */
export function EmailPrivacy() {
  const [policy, setPolicy] = useState<Policy>({ excludedSenders: [], excludedLabels: [], genericAppointmentOptIn: false, revision: 1 });
  // The fields keep what was typed, commas and spaces included; they become lists only when saved.
  const [senders, setSenders] = useState('');
  const [labels, setLabels] = useState('');
  const [notice, setNotice] = useState('');
  const show = (next: Policy) => { setPolicy(next); setSenders(next.excludedSenders.join(', ')); setLabels(next.excludedLabels.join(', ')); };
  useEffect(() => { void apiFetch<{ data: Policy }>('/source-policy').then((nextPolicy) => show(nextPolicy.data)).catch(() => setNotice('Could not load your email privacy settings. Reload to try again.')); }, []);
  async function savePolicy() { try { const response = await apiFetch<{ data: Policy }>('/source-policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...policy, excludedSenders: list(senders), excludedLabels: list(labels), expectedRevision: policy.revision }) }); show(response.data); setNotice('Source preferences saved.'); } catch { setNotice('Source preferences could not be saved.'); } }
  return <section className="card settings-card"><h2>Email privacy</h2><p>Excluded senders and labels stay private to your account. Work sources remain excluded from automatic household sharing.</p>
    {notice && <p role="status" className="notice">{notice}</p>}
    <label>Excluded senders<input value={senders} onChange={(event) => setSenders(event.target.value)} placeholder="news@example.com" /></label>
    <label>Excluded labels<input value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="Receipts" /></label>
    <label className="checkbox"><input type="checkbox" checked={policy.genericAppointmentOptIn} onChange={(event) => setPolicy({ ...policy, genericAppointmentOptIn: event.target.checked })} /> Share generic appointment logistics when I explicitly opt in</label>
    <button onClick={() => void savePolicy()}>Save source preferences</button>
  </section>;
}

/** What is shared, retained and sent to AI. Sits under the email suggestions card it refers to. */
export function PrivacyDisclosure() {
  return <section className="card settings-card"><h2>Privacy disclosure</h2><p>Household suggestions share only permitted logistics and facts; the source email and private evidence stay with you. Clear everyday logistics become shared suggestions automatically. Uncertain or personal items stay private until you share them. Medical sources stay private unless you opt into generic appointment logistics, without diagnosis or provider details. Work email, and email from excluded senders or labels, doesn’t become a suggestion at all. Work and personal calendars stay visible only to you.</p><p>Stored email and private extraction data are encrypted and deleted after 7 days. What you send the planner (photos, PDFs, text and links) and its replies are also deleted after 7 days. Shared plans and calendar events stay until the household deletes them. The server operator can access decrypted processing data.</p><p>Email suggestions above control background AI for your account separately from email sync and the planner. Hosted AI can retain submitted content under its provider policy; this is not a zero-retention service. Most providers keep API data for a limited time for abuse monitoring under their own policy. AI never receives sign-in tokens or authority to write calendars.</p></section>;
}
