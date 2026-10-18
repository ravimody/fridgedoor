import { describe, expect, it, vi } from 'vitest';
import { LlmExtractionProvider } from './extraction.js';
import { loadConfig } from '../config.js';
import { createAiProvider } from './ai.js';
import { AnthropicProvider } from '../llm/anthropic.js';
import { LlmHub } from '../llm/hub.js';
import { OpenAiResponsesProvider } from '../llm/openai.js';
import { resolveAiConfig } from '../settings.js';

const packet = { schemaVersion: 'v1', sourceVersionId: 'synthetic', timezone: 'America/New_York', ownerLabel: 'Owner', allowedParticipants: [], allowedCategories: ['school'], text: 'School fair October 25', truncated: false };
const result = { decision: 'private', category: 'school', confidence: 0.7, uncertaintyReasons: ['Year inferred'], privacyFlags: ['uncertain'], candidates: [{ decision: 'private', confidence: 0.7, privacyFlags: ['uncertain'], kind: 'event', relation: 'new', safeFacts: { title: 'School fair', category: 'school', participants: [], time: null, location: null, notes: null, preparationTasks: [], unresolvedFields: ['date'] }, sourceEvidence: [{ field: 'title', kind: 'text', textQuote: 'School fair', mediaPageRegion: null }], sourceTimeInterpretation: null, attention: null, unresolvedFields: ['date'] }] };
function response(output: unknown = result, status = 'completed') {
  return new Response(JSON.stringify({ id: 'resp_synthetic', object: 'response', status, model: 'test-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } }), { headers: { 'content-type': 'application/json' } });
}
const openai = (fetchMock: ReturnType<typeof vi.fn>, model = 'test-model') => new LlmExtractionProvider(new OpenAiResponsesProvider({ apiKey: 'synthetic-key', fetch: fetchMock as unknown as typeof fetch }), model);
const envHub = (env: Record<string, string>, fetchMock?: ReturnType<typeof vi.fn>) => { const config = loadConfig({ NODE_ENV: 'test', ...env }); return { config, hub: new LlmHub(() => resolveAiConfig(config), fetchMock ? { fetch: fetchMock as unknown as typeof fetch } : {}) }; };

describe('extraction', () => {
  it('needs a provider, model and key from the environment', () => {
    expect(envHub({ AI_MODEL_EXTRACT: 'test-model', OPENAI_API_KEY: 'synthetic-key' }).hub.configured()).toBe(false);
    expect(envHub({ AI_PROVIDER: 'openai', AI_MODEL_EXTRACT: 'test-model' }).hub.configured()).toBe(false);
    expect(envHub({ AI_PROVIDER: 'openai', AI_MODEL_EXTRACT: 'test-model', OPENAI_API_KEY: 'synthetic-key' }).hub.resolve('email')).toMatchObject({ model: 'test-model', provider: { id: 'openai' } });
  });

  it('sends explicit none reasoning for direct Luna extraction', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const { config, hub } = envHub({ AI_PROVIDER: 'openai', AI_MODEL_EXTRACT: 'gpt-6-luna', AI_EXTRACT_EFFORT: 'none', OPENAI_API_KEY: 'synthetic-key' }, fetchMock);
    const reserve = vi.fn();
    const value = await createAiProvider(hub, config).extract(packet, new AbortController().signal, reserve);
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(request).toMatchObject({ model: 'gpt-6-luna', reasoning: { effort: 'none' }, max_output_tokens: 12000 });
    expect(reserve).toHaveBeenCalledExactlyOnceWith('gpt-6-luna'); expect(value).toMatchObject({ provider: 'openai', model: 'gpt-6-luna' });
  });

  it('sends bounded packet media with strict output, no storage or tools; validates and converts nullable fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const value = await openai(fetchMock).extract({ ...packet, media: [{ kind: 'image', mimeType: 'image/png', dataBase64: 'cG5n' }, { kind: 'pdf', mimeType: 'application/pdf', dataBase64: 'cGRm' }] }, new AbortController().signal);
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(request.store).toBe(false); expect(request.tools).toBeUndefined(); expect(request.max_output_tokens).toBe(5000);
    expect(request.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(request.input[0].content.map((p: { type: string }) => p.type)).toEqual(['input_text', 'input_image', 'input_file']);
    expect(request.input[0].content[0].text).not.toContain('dataBase64');
    expect(value.result.candidates[0]!.safeFacts).not.toHaveProperty('time');
    expect(value.result.candidates[0]!.sourceEvidence[0]!.textSpan).toEqual({ start: 0, end: 11 });
    expect(value.usage).toEqual({ inputTokens: 100, outputTokens: 50, providerRequestId: 'resp_synthetic' });
  });

  it('rejects fabricated quotes rather than manufacturing evidence offsets', async () => {
    const invalid = structuredClone(result); invalid.candidates[0]!.sourceEvidence[0]!.textQuote = 'Text absent from the source';
    const fetchMock = vi.fn().mockResolvedValue(response(invalid));
    await expect(openai(fetchMock).extract(packet, new AbortController().signal)).rejects.toThrow('AI_EVIDENCE_QUOTE_MISSING');
  });

  it.each(['incomplete', 'failed'])('rejects %s responses without leaking source text', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(response(result, status));
    await expect(openai(fetchMock).extract(packet, new AbortController().signal)).rejects.toThrow(status === 'incomplete' ? 'AI_OUTPUT_INCOMPLETE' : 'AI_RESPONSE_FAILED');
  });

  it('applies domain date ordering validation after structured output parsing', async () => {
    const invalid = structuredClone(result); Object.assign(invalid.candidates[0]!.safeFacts, { time: { kind: 'timed', start: '2026-10-25T14:00:00Z', end: '2026-10-25T13:00:00Z', timezone: 'America/New_York' } });
    const fetchMock = vi.fn().mockResolvedValue(response(invalid));
    await expect(openai(fetchMock).extract(packet, new AbortController().signal)).rejects.toThrow('AI_DOMAIN_INVALID');
  });

  it.each([[429, 'AI_RETRYABLE'], [500, 'AI_RETRYABLE'], [401, 'AI_PROVIDER_FAILED']])('sanitizes HTTP %s errors without SDK retries', async (status, code) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'PRIVATE SOURCE OR KEY' } }), { status: Number(status), headers: { 'content-type': 'application/json' } }));
    await expect(openai(fetchMock).extract(packet, new AbortController().signal)).rejects.toThrow(String(code));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(openai(vi.fn()).extract(packet, controller.signal)).rejects.toThrow('AI_CANCELLED');
  });
});

it('recognizes truncation before trying to parse partial JSON', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'synthetic', object: 'response', model: 'test-model', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{private unfinished content', annotations: [] }] }] }), { headers: { 'content-type': 'application/json' } }));
  await expect(openai(fetchMock).extract(packet, new AbortController().signal)).rejects.toThrow(/^AI_OUTPUT_LIMIT$/);
});

it.each([
  [{ type: 'refusal', refusal: 'PRIVATE REFUSAL TEXT' }, 'AI_REFUSED'],
  [{ type: 'output_text', text: 'PRIVATE NOT JSON', annotations: [] }, 'AI_OUTPUT_INVALID_JSON'],
  [{ type: 'output_text', text: '{}', annotations: [] }, 'AI_OUTPUT_SCHEMA_INVALID'],
  [{ type: 'output_text', text: '', annotations: [] }, 'AI_OUTPUT_EMPTY'],
])('keeps diagnostic failures content-free', async (content, code) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'synthetic', object: 'response', model: 'test-model', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [content] }] }), { headers: { 'content-type': 'application/json' } }));
  try { await openai(fetchMock).extract(packet, new AbortController().signal); throw new Error('EXPECTED_FAILURE'); }
  catch (error) { expect((error as Error).message).toBe(code); }
});

it.each(['point', 'legacy'])('preserves an exact deadline (%s) without inventing a duration', async (shape) => {
  const output = structuredClone(result);
  Object.assign(output.candidates[0]!, { kind: 'deadline' });
  const at = '2026-09-18T17:00:00-04:00';
  Object.assign(output.candidates[0]!.safeFacts, { time: shape === 'point' ? { kind: 'deadline', at, timezone: 'America/New_York' } : { kind: 'timed', start: at, end: at, timezone: 'America/New_York' } });
  const fetchMock = vi.fn().mockResolvedValue(response(output));
  const value = await openai(fetchMock).extract(packet, new AbortController().signal);
  expect(value.result.candidates[0]!.safeFacts.time).toEqual({ kind: 'deadline', at, timezone: 'America/New_York' });
});

it('still rejects a zero-duration event', async () => {
  const output = structuredClone(result);
  Object.assign(output.candidates[0]!.safeFacts, { time: { kind: 'timed', start: '2026-09-18T17:00:00-04:00', end: '2026-09-18T17:00:00-04:00', timezone: 'America/New_York' } });
  const fetchMock = vi.fn().mockResolvedValue(response(output));
  await expect(openai(fetchMock).extract(packet, new AbortController().signal)).rejects.toThrow('AI_DOMAIN_INVALID');
});

it('extracts through Claude with the same wire schema, evidence mapping and usage accounting', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: 'msg_synthetic', model: 'claude-test-20260101', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'final_answer', input: result }], usage: { input_tokens: 80, output_tokens: 40, cache_read_input_tokens: 20 } }));
  const provider = new LlmExtractionProvider(new AnthropicProvider({ apiKey: 'synthetic-key', fetch: fetchMock as unknown as typeof fetch }), 'claude-test', 'low');
  const value = await provider.extract({ ...packet, media: [{ kind: 'pdf', mimeType: 'application/pdf', dataBase64: 'cGRm' }] }, new AbortController().signal);
  const [url, init] = fetchMock.mock.calls[0]!; const request = JSON.parse(init.body);
  expect(url).toBe('https://api.anthropic.com/v1/messages');
  expect(request).toMatchObject({ model: 'claude-test', max_tokens: 12000, tool_choice: { type: 'tool', name: 'final_answer' } });
  expect(request).not.toHaveProperty('reasoning');
  expect(request.messages[0].content.map((block: { type: string }) => block.type)).toEqual(['text', 'document']);
  expect(request.messages[0].content[0].text).not.toContain('dataBase64');
  const answer = request.tools.find((tool: { name: string }) => tool.name === 'final_answer').input_schema;
  expect(JSON.stringify(answer)).not.toContain('"nullable"');
  expect(value).toMatchObject({ provider: 'anthropic', model: 'claude-test', usage: { inputTokens: 100, outputTokens: 40, providerRequestId: 'msg_synthetic' } });
  expect(value.result.candidates[0]!.sourceEvidence[0]!.textSpan).toEqual({ start: 0, end: 11 });
  expect(value.result.candidates[0]!.safeFacts).not.toHaveProperty('location');
});

it.each([[429, 'AI_RETRYABLE'], [529, 'AI_RETRYABLE'], [400, 'AI_PROVIDER_FAILED']])('maps Claude HTTP %s to %s without provider text', async (status, code) => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { message: 'PRIVATE SOURCE' } }, { status: Number(status) }));
  const provider = new LlmExtractionProvider(new AnthropicProvider({ apiKey: 'synthetic-key', fetch: fetchMock as unknown as typeof fetch }), 'claude-test');
  await expect(provider.extract(packet, new AbortController().signal)).rejects.toThrow(new RegExp(`^${code}$`));
});
