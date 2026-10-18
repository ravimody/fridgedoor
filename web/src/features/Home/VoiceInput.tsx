import { useEffect, useRef, useState } from 'react';
import { monitorSilence } from './silence-stop.js';
import { apiFetch } from '../../api/client.js';
import { createDictation, recognitionConstructor } from './speech-recognition.js';
export function VoiceInput({ active, disabled, onText, onBusy }: { active: boolean; disabled: boolean; onText: (text: string, send: boolean) => void | Promise<void>; onBusy: (value: boolean) => void }) {
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle');
  const silence = useRef<(() => void) | undefined>(undefined);
  const native = useRef<ReturnType<typeof createDictation> | undefined>(undefined);
  const Constructor = recognitionConstructor();
  const [clip, setClip] = useState<Blob>(); const [notice, setNotice] = useState('');
  const recorder = useRef<MediaRecorder | undefined>(undefined); const stream = useRef<MediaStream | undefined>(undefined); const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0); const upload = useRef<AbortController | undefined>(undefined); const mounted = useRef(true);
  const busy = state !== 'idle';
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  function stop() { silence.current?.(); silence.current = undefined; native.current?.stop(); clearTimeout(timer.current); if (recorder.current?.state === 'recording') recorder.current.stop(); stream.current?.getTracks().forEach((track) => track.stop()); }
  // Closing the composer resets the recorder: state during render, the device and network work in an effect.
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) { setWasActive(active); if (!active) { setState('idle'); setClip(undefined); setNotice(''); } }
  useEffect(() => { if (!active) { generation.current++; native.current?.abort(); native.current = undefined; stop(); upload.current?.abort(); } }, [active]);
  const busyChanged = useRef(onBusy); useEffect(() => { busyChanged.current = onBusy; }, [onBusy]);
  // Unmounting cancels any recording or upload in flight; the counter makes late results from it ignored.
  useEffect(() => { const attempts = generation; mounted.current = true; return () => { mounted.current = false; attempts.current++; native.current?.abort(); native.current = undefined; stop(); upload.current?.abort(); busyChanged.current(false); }; }, []);
  async function transcribe(audio: Blob) {
    const attempt = generation.current;
    setState('transcribing'); setNotice('Transcribing…');
    const controller = new AbortController(); upload.current = controller;
    try {
      const body = new FormData(); body.set('file', audio, audio.type.includes('mp4') ? 'recording.mp4' : 'recording.webm');
      const result = await apiFetch<{ data: { text: string } }>('/assistant/transcribe', { method: 'POST', body, signal: controller.signal });
      if (!mounted.current || attempt !== generation.current) return;
      await onText(result.data.text, true); if (!mounted.current || attempt !== generation.current) return; setClip(undefined); setNotice('');
    } catch { if (mounted.current && attempt === generation.current) setNotice('Could not transcribe. Your recording is still here; retry or use keyboard dictation.'); }
    finally { if (mounted.current && attempt === generation.current) setState('idle'); }
  }
  async function start() {
    const localRecording = typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined' && typeof AudioContext !== 'undefined';
    // Browser recognition can advertise support without delivering speechend.
    if (Constructor && !localRecording) {
      const attempt = ++generation.current;
      setClip(undefined); setState('recording'); setNotice('Listening…');
      try {
        const session = createDictation(Constructor, (text, failed) => {
          if (!mounted.current || attempt !== generation.current) return;
          native.current = undefined;
          if (!text) { setState('idle'); setNotice('No speech received. Tap the mic to try again.'); return; }
          setState('transcribing'); setNotice('Finishing…');
          void Promise.resolve().then(() => {
            if (mounted.current && attempt === generation.current) return onText(text, !failed);
          }).then(() => {
            if (!mounted.current || attempt !== generation.current) return;
            setNotice(failed ? 'Dictation was interrupted. Review the captured text before sending.' : '');
          }).catch(() => {
            if (mounted.current && attempt === generation.current) setNotice('Could not send. Review your message and try again.');
          }).finally(() => { if (mounted.current && attempt === generation.current) setState('idle'); });
        });
        native.current = session; session.start();
      } catch { setState('idle'); setNotice('Could not start the microphone. Try again or use keyboard dictation.'); }
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setNotice('Recording is unavailable in this browser. Use your keyboard’s microphone.'); return; }
    const attempt = ++generation.current; setState('starting'); setNotice('');
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || attempt !== generation.current) { input.getTracks().forEach((track) => track.stop()); return; }
      stream.current = input;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
      const next = new MediaRecorder(input, mimeType ? { mimeType } : undefined); recorder.current = next;
      const chunks: Blob[] = []; let size = 0; let failed = false;
      next.ondataavailable = (event) => { size += event.data.size; if (size > 5 * 1024 * 1024) { failed = true; stop(); } else chunks.push(event.data); };
      next.onerror = () => { failed = true; stop(); if (mounted.current && attempt === generation.current) { setState('idle'); setNotice('Recording failed. Try again or use keyboard dictation.'); } };
      next.onstop = () => {
        if (attempt === generation.current) { silence.current?.(); silence.current = undefined; }
        clearTimeout(timer.current); input.getTracks().forEach((track) => track.stop());
        if (!mounted.current || attempt !== generation.current) return;
        setState('idle');
        if (failed || !size) { setNotice('No usable speech received. Tap the mic to try again.'); return; }
        const audio = new Blob(chunks, { type: next.mimeType }); setClip(audio);
        void transcribe(audio);
      };
      const release = await monitorSilence(input, (speech) => { if (!speech) failed = true; stop(); });
      if (!mounted.current || attempt !== generation.current) { release?.(); input.getTracks().forEach((track) => track.stop()); return; }
      silence.current = release;
      next.start(1000); setClip(undefined); setState('recording'); setNotice('Listening…'); timer.current = setTimeout(stop, 120000);
    } catch { stop(); if (mounted.current && attempt === generation.current) { setState('idle'); setNotice('Microphone access was unavailable. Allow it in browser settings or use keyboard dictation.'); } }
  }
  const label = state === 'recording' ? 'Finish recording' : busy ? 'Sending voice' : 'Record voice';
  return <div className="voice-input">
    <button type="button" className={`voice-button${state === 'recording' ? ' recording' : ''}`} aria-label={label} title={label} disabled={disabled || (busy && state !== 'recording')} onClick={() => state === 'recording' ? stop() : void start()}>
      {state === 'recording' ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></svg>}
    </button>
    {notice && <span role="status">{notice}</span>}
    {clip && !busy && <button className="secondary" disabled={disabled} onClick={() => void transcribe(clip)}>Retry voice</button>}
  </div>;
}
