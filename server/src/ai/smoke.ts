// Explicit operator-only smoke test: fixed synthetic content, no DB or user data.
import { readFile } from 'node:fs/promises';
import { LlmExtractionProvider } from '../providers/extraction.js';
import { scriptAi } from '../settings.js';
import type { ExtractionPacket } from '../providers/ai-contracts.js';
import { validateEvidence } from './policy.js';

const model = process.argv[2];
const resolved = model ? scriptAi(model).hub.resolve('email') : undefined;
if (!resolved) {
  process.stderr.write('Supply a model argument and AI_PROVIDER (plus AI_API_KEY for hosted providers) in the environment.\n');
  process.exit(1);
}
const image = process.argv.includes('--image');
const text = 'Example School Fair. October 25, 2026, 10 AM to 1 PM. 100 Example Road. Crafts and music.';
const packet: ExtractionPacket = {
  schemaVersion: 'extract-v1', sourceVersionId: 'synthetic-smoke',
  referenceTime: '2026-09-12T12:00:00Z', timezone: 'America/New_York', ownerLabel: 'Example Owner',
  allowedParticipants: ['Example Owner'], allowedCategories: ['school'], text: image ? '' : text, truncated: false,
};
if (image) {
  const png = await readFile(new URL('./fixtures/smoke-poster.png', import.meta.url));
  packet.media = [{ kind: 'image', mimeType: 'image/png', dataBase64: png.toString('base64'), width: 900, height: 300 }];
}
const started = Date.now();
try {
  const response = await new LlmExtractionProvider(resolved.provider, resolved.model).extract(packet, AbortSignal.timeout(45_000));
  validateEvidence(response.result, packet);
  if (!response.result.candidates.some((candidate) => candidate.kind === 'event')) throw new Error('AI_SMOKE_NO_EVENT');
  process.stdout.write(JSON.stringify({ model: response.model, requestedModel: model, input: image ? 'synthetic-image' : 'synthetic-text', elapsedMs: Date.now() - started, candidates: response.result.candidates.length, usage: response.usage, valid: true }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ model, input: image ? 'synthetic-image' : 'synthetic-text', elapsedMs: Date.now() - started, error: error instanceof Error && /^AI_[A-Z_]+$/.test(error.message) ? error.message : 'AI_SMOKE_FAILED', valid: false }) + '\n');
  process.exitCode = 1;
}
