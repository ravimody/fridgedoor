import { afterEach, expect, it, vi } from 'vitest';
import { createDictation, recognitionConstructor, type Recognition } from './speech-recognition.js';
class Recognizer implements Recognition {
  static latest: Recognizer;
  constructor() { Recognizer.latest = this; }
  lang = ''; continuous = true; interimResults = true;
  onresult: Recognition['onresult'] = null; onspeechend: Recognition['onspeechend'] = null;
  onend: Recognition['onend'] = null; onerror: Recognition['onerror'] = null;
  start = vi.fn(); stop = vi.fn(); abort = vi.fn();
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('detects the prefixed browser implementation', () => {
  vi.stubGlobal('webkitSpeechRecognition', Recognizer);
  expect(recognitionConstructor()).toBe(Recognizer);
});
it('waits for final results after speechend and completes only once', () => {
  const complete = vi.fn(); const session = createDictation(Recognizer, complete); session.start();
  const r = Recognizer.latest; const end = r.onend!;
  r.onspeechend!(); r.onspeechend!(); expect(r.stop).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
  r.onresult!({ results: [{ isFinal: true, 0: { transcript: 'Drinks Monday at six' } }, { isFinal: false, 0: { transcript: 'unfinished' } }] });
  end(); end(); expect(complete).toHaveBeenCalledExactlyOnceWith('Drinks Monday at six', false);
});
it('manual Stop requests final recognition, while cancellation suppresses late callbacks', () => {
  const complete = vi.fn(); const session = createDictation(Recognizer, complete); session.start();
  const r = Recognizer.latest; const end = r.onend!; const result = r.onresult!;
  session.stop(); expect(r.stop).toHaveBeenCalledOnce(); session.abort();
  result({ results: [{ isFinal: true, 0: { transcript: 'Do not send' } }] }); end();
  expect(complete).not.toHaveBeenCalled(); expect(r.abort).toHaveBeenCalledOnce();
});
it('bounds missing end callbacks and marks partial results for review', () => {
  vi.useFakeTimers(); const complete = vi.fn(); const session = createDictation(Recognizer, complete); session.start();
  const r = Recognizer.latest;
  r.onresult!({ results: [{ isFinal: true, 0: { transcript: 'Partial text' } }] });
  vi.advanceTimersByTime(120000); expect(r.stop).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5000); expect(complete).toHaveBeenCalledExactlyOnceWith('Partial text', true);
});
it('handles browser denial without waiting forever', () => {
  const complete = vi.fn(); const session = createDictation(Recognizer, complete); session.start();
  Recognizer.latest.onerror!(); expect(complete).toHaveBeenCalledExactlyOnceWith('', true);
});
