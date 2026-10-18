import { expect, it } from 'vitest';
import { pauseDetector } from './silence-stop.js';
it('waits through pauses within speech and finishes after a sustained pause', () => {
  const detect = pauseDetector();
  expect(detect(0.05, 500)).toBeUndefined();
  expect(detect(0, 1000)).toBeUndefined();
  expect(detect(0.05, 500)).toBeUndefined();
  expect(detect(0, 1499)).toBeUndefined();
  expect(detect(0, 1)).toBe('speech-ended');
});
it('does not treat a brief click or prolonged silence as speech to send', () => {
  const detect = pauseDetector();
  expect(detect(0.1, 50)).toBeUndefined();
  expect(detect(0, 9900)).toBeUndefined();
  expect(detect(0, 50)).toBe('no-speech');
});
