// The recorder detects pauses locally; no second speech service runs.
export function pauseDetector() {
  let voiced = 0; let lastVoice = 0; let elapsed = 0;
  return (rms: number, milliseconds: number): 'speech-ended' | 'no-speech' | undefined => {
    elapsed += milliseconds;
    if (rms >= 0.015) { voiced += milliseconds; lastVoice = elapsed; }
    if (voiced >= 250 && elapsed - lastVoice >= 1500) return 'speech-ended';
    if (voiced < 250 && elapsed >= 10000) return 'no-speech';
  };
}
export async function monitorSilence(stream: MediaStream, done: (speech: boolean) => void) {
  if (typeof AudioContext === 'undefined') return undefined;
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream); const analyser = context.createAnalyser();
  analyser.fftSize = 2048; source.connect(analyser);
  const close = () => { source.disconnect(); void context.close().catch(() => {}); };
  try { await context.resume(); } catch { close(); return undefined; }
  const values = new Float32Array(analyser.fftSize); const detect = pauseDetector();
  const interval = setInterval(() => {
    analyser.getFloatTimeDomainData(values);
    const result = detect(Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length), 50);
    if (result) { clearInterval(interval); done(result === 'speech-ended'); }
  }, 50);
  return () => { clearInterval(interval); close(); };
}
