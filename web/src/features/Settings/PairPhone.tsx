import { useEffect, useRef, useState } from 'react';
import type { PhonePairing } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
import { errorMessage, FormError } from '../Auth/forms.js';

/** Shows a short-lived QR code (made by the server) that signs the Fridgedoor iPhone app in to this account. */
export function PairPhone({ autoStart = false }: { autoStart?: boolean }) {
  const [pairing, setPairing] = useState<PhonePairing>();
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);

  async function create() {
    setBusy(true); setError('');
    try { setPairing((await apiFetch<{ data: PhonePairing }>('/devices/pairing', { method: 'POST' })).data); setExpired(false); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (autoStart && !started.current) { started.current = true; void create(); } }, [autoStart]);
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairing]);

  return <div className="pair-phone">
    <ol>
      <li>Install the Fridgedoor app on your iPhone.</li>
      <li>Open the iPhone’s Camera and point it at the code below, then tap the Fridgedoor link that appears.</li>
    </ol>
    {pairing && !expired && <>
      <img className="qr-code" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qrSvg)}`} alt="QR code that connects the Fridgedoor iPhone app to your account" />
      <p className="field-hint">This code works once, for 10 minutes. Reading this on your iPhone? <a className="button secondary" href={pairing.link}>Open in the Fridgedoor app</a></p>
    </>}
    {pairing && expired && <p role="status" className="notice">That code has expired. Make a new one when your phone is ready.</p>}
    {busy && <p role="status" className="muted">Making a code…</p>}
    <FormError message={error} />
    {(!pairing || expired || error) && !busy && <button onClick={() => void create()}>{pairing ? 'Make a new code' : 'Show a pairing code'}</button>}
  </div>;
}
