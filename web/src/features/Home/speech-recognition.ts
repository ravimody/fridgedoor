// Web Speech is not included in TypeScript's DOM declarations in every version.
export type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onspeechend: (() => void) | null; onend: (() => void) | null; onerror: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
export type RecognitionConstructor = new () => Recognition;
export function recognitionConstructor(): RecognitionConstructor | undefined {
  const browser = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}
export function createDictation(Constructor: RecognitionConstructor, complete: (text: string, failed: boolean) => void) {
  const recognition = new Constructor();
  recognition.lang = navigator.language || 'en-US'; recognition.continuous = false; recognition.interimResults = false;
  let finished = false; let stopping = false; let text = '';
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function detach() {
    clearTimeout(deadline);
    recognition.onresult = null; recognition.onspeechend = null; recognition.onend = null; recognition.onerror = null;
  }
  function finish(failed: boolean) {
    if (finished) return; finished = true; detach();
    try { recognition.abort(); } catch { /* Already ended. */ }
    complete(text.trim(), failed);
  }
  function stop() {
    if (finished || stopping) return; stopping = true;
    clearTimeout(deadline); deadline = setTimeout(() => finish(true), 5000);
    // stop requests final results; abort would discard the last spoken words.
    try { recognition.stop(); } catch { finish(true); }
  }
  recognition.onresult = (event) => {
    if (finished) return;
    text = Array.from(event.results).filter((result) => result.isFinal).map((result) => result[0].transcript).join(' ');
  };
  recognition.onspeechend = stop;
  recognition.onend = () => finish(false);
  recognition.onerror = () => finish(true);
  return {
    start() { deadline = setTimeout(stop, 120000); try { recognition.start(); } catch { finish(true); } },
    stop,
    abort() { if (finished) return; finished = true; detach(); try { recognition.abort(); } catch { /* Already ended. */ } },
  };
}
