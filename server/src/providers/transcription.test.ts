import { expect, it, vi } from 'vitest';
import { LlmHub } from '../llm/hub.js';
import { canTranscribe, transcribe, MAX_AUDIO_BYTES, TranscriptionLimiter, TRANSCRIPTIONS_PER_HOUR } from './transcription.js';
const hub = (request: typeof fetch, provider = 'openai') => new LlmHub(() => ({ provider, apiKey: 'synthetic-key', models: { main: 'synthetic-main' } }), { fetch: request });
it('sends bounded audio to transcription without household context and returns only text', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ text: '  Drinks with Bob on Monday at six.  ', usage: { input_tokens: 12 } })));
  expect(await transcribe(new File(['fixture'], 'personal-name.mp4', { type: 'audio/mp4' }), hub(request))).toBe('Drinks with Bob on Monday at six.');
  const [url, options] = request.mock.calls[0]!;
  expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
  const form = options!.body as FormData;
  expect([...form.keys()]).toEqual(['file', 'model', 'response_format']);
  expect((form.get('file') as File).name).toBe('recording.mp4');
  expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
});
it('rejects oversized or unsupported recordings before calling the provider and hides provider errors', async () => {
  const request = vi.fn<typeof fetch>();
  await expect(transcribe(new File(['text'], 'file.txt', { type: 'text/plain' }), hub(request))).rejects.toThrow('INVALID_AUDIO');
  await expect(transcribe(new File([new Uint8Array(MAX_AUDIO_BYTES + 1)], 'file.webm', { type: 'audio/webm' }), hub(request))).rejects.toThrow('INVALID_AUDIO');
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValue(new Response('private provider diagnostic', { status: 500 }));
  await expect(transcribe(new File(['fixture'], 'file.webm', { type: 'audio/webm' }), hub(request))).rejects.toThrow(/^TRANSCRIPTION_FAILED$/);
});
it('reports transcription as unavailable when the provider has no speech-to-text', async () => {
  const request = vi.fn<typeof fetch>();
  expect(canTranscribe(hub(request, 'anthropic'))).toBe(false);
  await expect(transcribe(new File(['fixture'], 'file.webm', { type: 'audio/webm' }), hub(request, 'anthropic'))).rejects.toThrow('TRANSCRIPTION_UNAVAILABLE');
  expect(canTranscribe(hub(request, 'groq'))).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it('keeps the hourly voice allowance across restarts', async () => {
  const { default: Database } = await import('better-sqlite3'); const { migrate } = await import('../db/migrate.js');
  const db = new Database(':memory:'); migrate(db); let now = new Date('2026-09-12T12:00:00Z');
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h', now.toISOString());
  db.prepare("INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES ('m', 'h', 's', 'M', 'UTC', 1, ?)").run(now.toISOString());
  for (let i = 0; i < TRANSCRIPTIONS_PER_HOUR; i++) expect(new TranscriptionLimiter(db, () => now).allow('m')).toBe(true);
  expect(new TranscriptionLimiter(db, () => now).allow('m')).toBe(false);
  now = new Date(now.getTime() + 3600_001);
  expect(new TranscriptionLimiter(db, () => now).allow('m')).toBe(true);
});
