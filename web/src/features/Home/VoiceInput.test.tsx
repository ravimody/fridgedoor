import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { VoiceInput } from './VoiceInput.js';
import { apiFetch } from '../../api/client.js';
vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('stops tracks and retries a failed transcription before automatically sending', async () => {
  const stopTrack = vi.fn();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) } });
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'audio/webm';
    ondataavailable?: (e: { data: Blob }) => void; onstop?: () => void;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['synthetic audio']) }); this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error('NETWORK')).mockResolvedValueOnce({ data: { text: 'Drinks Monday at six' } });
  const onText = vi.fn();
  render(<VoiceInput active disabled={false} onText={onText} onBusy={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Record voice' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Finish recording' }));
  expect(stopTrack).toHaveBeenCalled();
  expect(await screen.findByText(/Could not transcribe/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retry voice' }));
  await waitFor(() => expect(onText).toHaveBeenCalledWith('Drinks Monday at six', true));
  expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual(['/assistant/transcribe', '/assistant/transcribe']);
  expect(screen.queryByRole('button', { name: 'Retry voice' })).not.toBeInTheDocument();
});
it('explains denied microphone access without touching the existing message', async () => {
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new Error('denied')) } });
  vi.stubGlobal('MediaRecorder', class {});
  const onText = vi.fn();
  render(<VoiceInput active disabled={false} onText={onText} onBusy={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Record voice' }));
  expect(await screen.findByText(/Microphone access was unavailable/)).toBeVisible();
  expect(onText).not.toHaveBeenCalled(); expect(apiFetch).not.toHaveBeenCalled();
});
it('does not auto-send a transcription that completes after closing the input', async () => {
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) } });
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'audio/webm'; ondataavailable?: (e: { data: Blob }) => void; onstop?: () => void;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['synthetic']) }); this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  let finish!: (value: unknown) => void;
  vi.mocked(apiFetch).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const onText = vi.fn(); const onBusy = vi.fn();
  const view = render(<VoiceInput active disabled={false} onText={onText} onBusy={onBusy} />);
  fireEvent.click(screen.getByRole('button', { name: 'Record voice' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Finish recording' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  view.rerender(<VoiceInput active={false} disabled={false} onText={onText} onBusy={onBusy} />);
  expect(vi.mocked(apiFetch).mock.calls[0]![1]?.signal?.aborted).toBe(true);
  finish({ data: { text: 'Do not send this' } });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry voice' })).not.toBeInTheDocument());
  expect(onText).not.toHaveBeenCalled();
});
it('auto-sends browser dictation after speechend without an audio upload', async () => {
  let recognition!: { onspeechend: () => void; onresult: (e: unknown) => void; onend: () => void; stop: ReturnType<typeof vi.fn> };
  class Speech {
    constructor() { recognition = this as unknown as typeof recognition; }
    start = vi.fn(); stop = vi.fn(); abort = vi.fn();
  }
  vi.stubGlobal('webkitSpeechRecognition', Speech);
  const onText = vi.fn();
  render(<VoiceInput active disabled={false} onText={onText} onBusy={vi.fn()} />);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Record voice' }));
  recognition.onspeechend(); expect(recognition.stop).toHaveBeenCalledOnce();
  recognition.onresult({ results: [{ isFinal: true, 0: { transcript: 'Add apples' } }] });
  recognition.onend();
  await waitFor(() => expect(onText).toHaveBeenCalledWith('Add apples', true));
  expect(apiFetch).not.toHaveBeenCalled();
});
it('cancels browser dictation when the composer closes', async () => {
  let recognition!: { onend: () => void; abort: ReturnType<typeof vi.fn> };
  class Speech {
    constructor() { recognition = this as unknown as typeof recognition; }
    start = vi.fn(); stop = vi.fn(); abort = vi.fn();
  }
  vi.stubGlobal('SpeechRecognition', Speech);
  const onText = vi.fn(); const onBusy = vi.fn();
  const view = render(<VoiceInput active disabled={false} onText={onText} onBusy={onBusy} />);
  fireEvent.click(screen.getByRole('button', { name: 'Record voice' }));
  const lateEnd = recognition.onend;
  view.rerender(<VoiceInput active={false} disabled={false} onText={onText} onBusy={onBusy} />);
  lateEnd();
  expect(recognition.abort).toHaveBeenCalledOnce(); expect(onText).not.toHaveBeenCalled();
});

it('detects a pause and sends even when advertised browser recognition would never end', async () => {
  const { act } = await import('@testing-library/react');
  vi.useFakeTimers();
  try {
    let speaking = true;
    const stopTrack = vi.fn(); const close = vi.fn().mockResolvedValue(undefined);
    const speechConstructor = vi.fn(); vi.stubGlobal('webkitSpeechRecognition', speechConstructor);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) } });
    vi.stubGlobal('AudioContext', class {
      createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
      createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData: (values: Float32Array) => values.fill(speaking ? 0.05 : 0) }; }
      resume = vi.fn().mockResolvedValue(undefined); close = close;
    });
    vi.stubGlobal('MediaRecorder', class {
      static isTypeSupported() { return true; }
      state = 'inactive'; mimeType = 'audio/mp4';
      ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void;
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['synthetic audio']) }); this.onstop?.(); }
    });
    vi.mocked(apiFetch).mockResolvedValue({ data: { text: 'Add bananas to my grocery list' } });
    const onText = vi.fn();
    render(<VoiceInput active disabled={false} onText={onText} onBusy={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Record voice' })); });
    expect(screen.getByText('Listening…')).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    speaking = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(speechConstructor).not.toHaveBeenCalled();
    expect(onText).toHaveBeenCalledExactlyOnceWith('Add bananas to my grocery list', true);
    expect(apiFetch).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByText('Listening…')).not.toBeInTheDocument();
  } finally { cleanup(); vi.useRealTimers(); }
});
