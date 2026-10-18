import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from './anthropic.js';
import { LlmHub, createProvider } from './hub.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import { OpenAiResponsesProvider } from './openai.js';
import { portableSchema } from './schema.js';
import type { LlmMessage } from './types.js';

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };
function fakeFetch(...responses: Array<Record<string, unknown> | number>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {} });
    const next = responses.shift();
    if (typeof next === 'number') return new Response('{"error":{"message":"secret request echo"}}', { status: next });
    return Response.json(next ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const schema = z.object({ title: z.string(), when: z.string().nullable() }).strict();
const user = (text: string): LlmMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const signal = new AbortController().signal;

describe('OpenAI Responses adapter', () => {
  it('sends strict structured output without storing the request and parses the answer', async () => {
    const fetch = fakeFetch({ id: 'resp_1', model: 'gpt-test', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"title":"Bake sale","when":null}' }] }], usage: { input_tokens: 10, output_tokens: 4 } });
    const provider = new OpenAiResponsesProvider({ apiKey: 'sk-test', fetch: fetch.impl });
    const result = await provider.generate({ model: 'gpt-test', system: 'Be useful.', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'pdf', base64: 'JVBER' }] }], schema, schemaName: 'thing', reasoning: 'none', signal });
    expect(result).toMatchObject({ type: 'object', object: { title: 'Bake sale', when: null }, usage: { inputTokens: 10, outputTokens: 4 }, requestId: 'resp_1' });
    const body = fetch.calls[0]!.body;
    expect(fetch.calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(body).toMatchObject({ store: false, instructions: 'Be useful.', reasoning: { effort: 'none' }, text: { format: { type: 'json_schema', strict: true, name: 'thing' } } });
    expect(JSON.stringify(body.input)).toContain('data:application/pdf;base64,JVBER');
  });

  it('returns tool calls with replay items and continues the loop', async () => {
    const fetch = fakeFetch(
      { id: 'r1', status: 'completed', output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{"q":"x"}', parsed_arguments: { q: 'x' } }] },
      { id: 'r2', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"title":"Done","when":"today"}' }] }] },
    );
    const provider = new OpenAiResponsesProvider({ apiKey: 'sk', fetch: fetch.impl });
    const tools = [{ name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false } }];
    const first = await provider.generate({ model: 'm', system: 's', messages: [user('go')], schema, schemaName: 'thing', tools, signal });
    expect(first.type).toBe('tool_calls');
    if (first.type !== 'tool_calls') return;
    expect(first.calls).toEqual([{ id: 'c1', name: 'lookup', arguments: '{"q":"x"}' }]);
    const second = await provider.generate({ model: 'm', system: 's', messages: [user('go'), first.assistant, { role: 'tool', callId: 'c1', name: 'lookup', output: '{"ok":true}' }], schema, schemaName: 'thing', tools, signal });
    expect(second.type).toBe('object');
    const input = fetch.calls[1]!.body.input as Array<Record<string, unknown>>;
    expect(input.map((item) => item.type ?? item.role)).toEqual(['user', 'reasoning', 'function_call', 'function_call_output']);
    expect(input[2]).not.toHaveProperty('parsed_arguments');
  });

  it('maps failures to stable codes without echoing provider text', async () => {
    const provider = new OpenAiResponsesProvider({ apiKey: 'sk', fetch: fakeFetch(429, 500, 401, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }).impl });
    const run = () => provider.generate({ model: 'm', system: 's', messages: [user('x')], schema, schemaName: 'thing', signal });
    await expect(run()).rejects.toThrow(/^AI_RATE_LIMITED$/);
    await expect(run()).rejects.toThrow(/^AI_RETRYABLE$/);
    await expect(run()).rejects.toThrow(/^AI_AUTH_FAILED$/);
    await expect(run()).rejects.toThrow(/^AI_OUTPUT_LIMIT$/);
  });

  it('retries without reasoning when a model rejects it, and remembers that', async () => {
    const ok = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"title":"t","when":null}' }] }] };
    const fetch = fakeFetch(400, ok, ok);
    const provider = new OpenAiResponsesProvider({ apiKey: 'sk', fetch: fetch.impl });
    const run = () => provider.generate({ model: 'older-model', system: 's', messages: [user('x')], schema, schemaName: 'thing', reasoning: 'high', signal });
    expect((await run()).type).toBe('object');
    expect((await run()).type).toBe('object');
    expect(fetch.calls.map((call) => 'reasoning' in call.body)).toEqual([true, false, false]);
  });
});

describe('Anthropic adapter', () => {
  it('forces the answer tool and converts images and PDFs', async () => {
    const fetch = fakeFetch({ id: 'msg_1', model: 'claude-test', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'final_answer', input: { title: 'Picture day', when: null } }], usage: { input_tokens: 20, output_tokens: 6 } });
    const provider = new AnthropicProvider({ apiKey: 'sk-ant', fetch: fetch.impl });
    const result = await provider.generate({ model: 'claude-test', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'flyer' }, { type: 'image', mimeType: 'image/png', base64: 'iVBOR' }, { type: 'pdf', base64: 'JVBER' }] }], schema, schemaName: 'thing', maxOutputTokens: 1000, signal });
    expect(result).toMatchObject({ type: 'object', object: { title: 'Picture day', when: null }, usage: { inputTokens: 20, outputTokens: 6 } });
    const call = fetch.calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect((call.init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant');
    expect(call.body).toMatchObject({ max_tokens: 1000, system: 'sys', tool_choice: { type: 'tool', name: 'final_answer' } });
    const content = (call.body.messages as Array<{ content: Array<{ type: string }> }>)[0]!.content.map((block) => block.type);
    expect(content).toEqual(['text', 'image', 'document']);
    const answerSchema = (call.body.tools as Array<{ name: string; input_schema: { properties: { when: unknown } } }>).find((tool) => tool.name === 'final_answer')!.input_schema;
    expect(answerSchema.properties.when).toEqual({ type: ['string', 'null'] });
  });

  it('runs a tool loop with tool results inside a user turn', async () => {
    const fetch = fakeFetch(
      { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'tu1', name: 'lookup', input: { q: 'x' } }] },
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu2', name: 'final_answer', input: { title: 'ok', when: null } }] },
    );
    const provider = new AnthropicProvider({ apiKey: 'k', fetch: fetch.impl });
    const tools = [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }];
    const first = await provider.generate({ model: 'm', system: 's', messages: [user('go')], schema, schemaName: 'thing', tools, signal });
    if (first.type !== 'tool_calls') throw new Error('expected tool calls');
    expect(fetch.calls[0]!.body.tool_choice).toEqual({ type: 'any', disable_parallel_tool_use: true });
    await provider.generate({ model: 'm', system: 's', messages: [user('go'), first.assistant, { role: 'tool', callId: 'tu1', name: 'lookup', output: 'found' }], schema, schemaName: 'thing', tools, signal });
    const messages = fetch.calls[1]!.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[2]!.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu1', content: 'found' });
  });

  it('reports a truncated answer', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', fetch: fakeFetch({ stop_reason: 'max_tokens', content: [] }).impl });
    await expect(provider.generate({ model: 'm', system: 's', messages: [user('x')], schema, schemaName: 'thing', signal })).rejects.toThrow(/^AI_OUTPUT_LIMIT$/);
  });
});

describe('OpenAI-compatible adapter', () => {
  it('uses json_schema response format and omits auth for keyless local servers', async () => {
    const fetch = fakeFetch({ id: 'c1', model: 'llama', choices: [{ finish_reason: 'stop', message: { content: '```json\n{"title":"Soccer","when":"5pm"}\n```' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
    const provider = new OpenAiCompatibleProvider({ id: 'ollama', baseUrl: 'http://localhost:11434/v1/', fetch: fetch.impl });
    const result = await provider.generate({ model: 'llama', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'pdf', base64: 'JVBER' }] }], schema, schemaName: 'thing', signal });
    expect(result).toMatchObject({ type: 'object', object: { title: 'Soccer', when: '5pm' }, usage: { inputTokens: 7, outputTokens: 3 } });
    expect(fetch.calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(fetch.calls[0]!.init.headers).not.toHaveProperty('authorization');
    expect(fetch.calls[0]!.body).toMatchObject({ response_format: { type: 'json_schema', json_schema: { name: 'thing', strict: true } } });
    expect((fetch.calls[0]!.body.messages as Array<{ content: unknown }>)[1]!.content).toContain('cannot read PDFs');
  });

  it('puts the schema in the prompt for JSON mode and repairs one bad answer', async () => {
    const fetch = fakeFetch(
      { choices: [{ message: { content: '{"title":3}' } }] },
      { choices: [{ message: { content: '{"title":"Fixed","when":null}' } }] },
    );
    const provider = new OpenAiCompatibleProvider({ id: 'deepseek', baseUrl: 'https://api.example.test/v1', apiKey: 'k', structuredOutput: 'json_object', fetch: fetch.impl });
    const result = await provider.generate({ model: 'm', system: 'sys', messages: [user('x')], schema, schemaName: 'thing', signal });
    expect(result).toMatchObject({ type: 'object', object: { title: 'Fixed', when: null } });
    expect(fetch.calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect((fetch.calls[0]!.body.messages as Array<{ content: string }>)[0]!.content).toContain('JSON Schema');
    expect((fetch.calls[1]!.body.messages as Array<{ content: string }>).at(-1)!.content).toContain('title: invalid_type');
  });

  it('sends reasoning_effort only for real effort levels', async () => {
    const fetch = fakeFetch({ choices: [{ message: { content: '{"title":"t","when":null}' } }] }, { choices: [{ message: { content: '{"title":"t","when":null}' } }] });
    const provider = new OpenAiCompatibleProvider({ id: 'xai', baseUrl: 'https://api.example.test/v1', apiKey: 'k', reasoningEffortParam: true, fetch: fetch.impl });
    await provider.generate({ model: 'm', system: 's', messages: [user('x')], schema, schemaName: 'thing', reasoning: 'none', signal });
    await provider.generate({ model: 'm', system: 's', messages: [user('x')], schema, schemaName: 'thing', reasoning: 'low', signal });
    expect(fetch.calls[0]!.body).not.toHaveProperty('reasoning_effort');
    expect(fetch.calls[1]!.body.reasoning_effort).toBe('low');
  });

  it('round-trips tool calls in Chat Completions format', async () => {
    const fetch = fakeFetch(
      { choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] } }] },
      { choices: [{ message: { content: '{"title":"t","when":null}' } }] },
    );
    const provider = new OpenAiCompatibleProvider({ id: 'groq', baseUrl: 'https://api.example.test/v1', apiKey: 'k', fetch: fetch.impl });
    const tools = [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }];
    const first = await provider.generate({ model: 'm', system: 's', messages: [user('go')], schema, schemaName: 'thing', tools, signal });
    if (first.type !== 'tool_calls') throw new Error('expected tool calls');
    await provider.generate({ model: 'm', system: 's', messages: [user('go'), first.assistant, { role: 'tool', callId: 'call_1', name: 'lookup', output: 'r' }], schema, schemaName: 'thing', tools, signal });
    const messages = fetch.calls[1]!.body.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'r' });
  });
});

describe('schemas and the hub', () => {
  it('turns OpenAPI nullable into standard JSON Schema', () => {
    const json = portableSchema(z.object({ a: z.string().nullable(), e: z.enum(['x', 'y']).nullable(), b: z.object({ c: z.number() }).nullable() }), 'n') as { properties: Record<string, unknown> };
    expect(json.properties.a).toEqual({ type: ['string', 'null'] });
    expect(json.properties.e).toEqual({ anyOf: [{ type: 'string', enum: ['x', 'y'] }, { type: 'null' }] });
    expect(json.properties.b).toMatchObject({ anyOf: [{ type: 'object' }, { type: 'null' }] });
    expect(JSON.stringify(json)).not.toContain('nullable');
  });

  it('resolves models by role and rebuilds the provider when settings change', () => {
    let config = { provider: 'anthropic', apiKey: 'k1', models: { main: 'claude-main' } as { main: string; email?: string } };
    const hub = new LlmHub(() => config);
    expect(hub.model('email')).toBe('claude-main');
    expect(hub.model('review')).toBeUndefined();
    const first = hub.provider();
    expect(first?.id).toBe('anthropic');
    expect(hub.provider()).toBe(first);
    config = { provider: 'openai', apiKey: 'k2', models: { main: 'gpt-main', email: 'gpt-small' } };
    expect(hub.provider()?.id).toBe('openai');
    expect(hub.resolve('email')?.model).toBe('gpt-small');
    expect(hub.model('transcribe')).toBe('gpt-4o-mini-transcribe');
  });

  it('treats a cloud provider without a key as not configured, but allows keyless local servers', () => {
    expect(new LlmHub(() => ({ provider: 'openai', models: { main: 'm' } })).configured()).toBe(false);
    expect(new LlmHub(() => ({ provider: 'ollama', models: { main: 'llama' } })).resolve('main')?.provider.id).toBe('ollama');
    expect(createProvider({ provider: 'gemini', apiKey: 'g', models: {} }).capabilities.webSearch).toBe(false);
  });
});
