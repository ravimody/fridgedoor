import { describe, expect, it, vi } from 'vitest';
import { LlmAgent } from './agent.js';
import { staticHub } from '../llm/hub.js';
import { OpenAiResponsesProvider } from '../llm/openai.js';
import { OpenAiCompatibleProvider } from '../llm/openai-compatible.js';
const parsed = { reply: 'Ready', sources: [], assumptions: [], followups: [], items: [], knowledge: [] };
const packet = { text: 'private marker', referenceTime: '2026-09-12T14:00:00Z', timezone: 'America/New_York', history: [], knowledge: [] };
type Body = { input: Array<Record<string, unknown>>; tools?: Array<{ type: string; name?: string }>; [key: string]: unknown };
const usage = { input_tokens: 10, output_tokens: 5 };
const answer = (value: unknown = parsed) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage });
const call = (name: string, args = '{}') => ({ status: 'completed', output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, { type: 'function_call', name, arguments: args, call_id: 'call1' }], usage });
const done = answer();
const search = { status: 'completed', output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: 'Verified public evidence', annotations: [{ type: 'url_citation', url: 'https://example.com/source' }] }] }], usage };
/** A fake OpenAI Responses endpoint: hosted web search requests get `search`, everything else the next scripted turn. */
function client(responses: unknown[]) {
  const turns: Body[] = []; const searches: Body[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Body;
    if (body.tools?.some((tool) => tool.type === 'web_search')) { searches.push(body); return Response.json(search); }
    turns.push(body); return Response.json(responses.shift() ?? done);
  });
  const hub = staticHub(new OpenAiResponsesProvider({ apiKey: 'synthetic', fetch: fetchImpl as unknown as typeof fetch }), { main: 'test' });
  return { hub, turns, searches };
}
const event = (start: string, end: string | null) => ({ intent: 'proposal', kind: 'event', title: 'Leaf Raking', quantity: null, start, end, location: null, notes: null });
describe('agent tool loop', () => {
  it.each([
    ['2026-09-13T01:53:03.875Z', 'America/New_York', '2026-09-12', '2026-09-12T21:53:03.875-04:00'],
    ['2026-09-13T04:01:00Z', 'America/New_York', '2026-09-13', '2026-09-13T00:01:00.000-04:00'],
    ['2026-09-12T16:00:00Z', 'Asia/Tokyo', '2026-09-13', '2026-09-13T01:00:00.000+09:00'],
    ['2026-11-01T06:30:00Z', 'America/New_York', '2026-11-01', '2026-11-01T01:30:00.000-05:00'],
  ])('anchors model and lookup dates to the submission instant %s in %s', async (instant, timezone, referenceDate, referenceTime) => {
    const c = client([call('public_lookup', '{"query":"public event"}'), done]);
    await new LlmAgent(c.hub).run({ ...packet, referenceTime: instant, timezone }, () => ({}), AbortSignal.timeout(1000));
    const sent = JSON.parse((c.turns[0]!.input[0]!.content as Array<{ text: string }>)[0]!.text);
    expect(sent).toMatchObject({ referenceTime, referenceDate, timezone });
    expect(JSON.parse(c.searches[0]!.input as unknown as string)).toEqual({ query: 'public event', referenceTime, referenceDate, timezone });
  });
  it.each([
    { referenceTime: 'invalid' }, { timezone: 'invalid/timezone' },
  ])('rejects invalid reference context before a provider call', async (override) => {
    const c = client([done]);
    await expect(new LlmAgent(c.hub).run({ ...packet, ...override }, () => ({}), AbortSignal.timeout(1000))).rejects.toThrow('AGENT_INVALID_TIME');
    expect(c.turns).toHaveLength(0);
  });
  it('uses authorized context and returns it only as tool output', async () => {
    const c = client([call('household_context'), done]); const context = vi.fn(() => ({ groceries: ['Apples'] }));
    const output = await new LlmAgent(c.hub).run(packet, context, AbortSignal.timeout(1000));
    expect(context).toHaveBeenCalledOnce(); expect(output.metrics).toMatchObject({ tools: ['household_context'], model: 'test', provider: 'openai' });
    expect(c.turns[0]).toMatchObject({ store: false, reasoning: { effort: 'none' }, parallel_tool_calls: false });
    expect(c.turns[1]!.input.map((item) => item.type ?? item.role)).toEqual(['user', 'reasoning', 'function_call', 'function_call_output']);
    expect(JSON.parse(c.turns[1]!.input[3]!.output as string)).toEqual({ groceries: ['Apples'] });
  });
  it('sends only public query to the lookup call and counts search usage', async () => {
    const c = client([call('public_lookup', '{"query":"public recipe example.com"}'), done]);
    const output = await new LlmAgent(c.hub).run(packet, () => ({}), AbortSignal.timeout(1000));
    expect(JSON.stringify(c.searches)).not.toContain('private marker'); expect(c.searches[0]).toMatchObject({ tool_choice: 'required', store: false });
    expect(output.metrics.inputTokens).toBe(30); expect(output.metrics.tools).toEqual(['web_search', 'public_lookup']);
    expect(JSON.parse(c.turns[1]!.input.at(-1)!.output as string)).toEqual({ evidence: 'Verified public evidence', sources: ['https://example.com/source'] });
  });
  it('rejects unknown tools and invalid event times', async () => {
    const c = client([call('send_email')]);
    await expect(new LlmAgent(c.hub).run(packet, () => ({}), AbortSignal.timeout(1000))).rejects.toThrow('AGENT_UNKNOWN_TOOL');
    const invalid = client([answer({ ...parsed, items: [event('2026-09-14T12:00:00-04:00', '2026-09-14T10:00:00-04:00')] })]);
    await expect(new LlmAgent(invalid.hub).run(packet, () => ({}), AbortSignal.timeout(1000))).rejects.toThrow('AGENT_INVALID_TIME');
  });
  it('assumes a default end for start-only events and discloses it', async () => {
    const c = client([answer({ ...parsed, items: [event('2026-11-21T09:00:00-05:00', null)] })]);
    const { result } = await new LlmAgent(c.hub).run(packet, () => ({}), AbortSignal.timeout(1000));
    expect(result.items[0]?.end).toBe('2026-11-21T10:00:00.000-05:00'); expect(result.assumptions).toEqual(['Assumed 1 hour since no end time was given: Leaf Raking']);
  });
  it('reads only Google shared-document exports and reports private documents', async () => {
    const sheet = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit?usp=sharing#gid=152';
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('Event,Date\nLeaf Raking,11/21', { headers: { 'content-type': 'text/csv' } }))
      .mockResolvedValueOnce(new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }));
    const c = client([call('read_shared_document', JSON.stringify({ url: sheet })), call('read_shared_document', JSON.stringify({ url: sheet })), call('read_shared_document', '{"url":"http://169.254.169.254/latest"}'), done]);
    await new LlmAgent(c.hub, 'none', fetchImpl as unknown as typeof fetch).run(packet, () => ({}), AbortSignal.timeout(1000));
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(Array(2).fill('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/export?format=csv&gid=152'));
    const outputs = c.turns[3]!.input.filter((item) => item.type === 'function_call_output').map((item) => JSON.parse(item.output as string));
    expect(outputs).toEqual([{ text: 'Event,Date\nLeaf Raking,11/21', truncated: false, source: sheet }, { error: 'DOCUMENT_NOT_PUBLIC' }, { error: 'UNSUPPORTED_LINK' }]);
  });
  it('bounds model-requested tool loops', async () => {
    const c = client(Array.from({ length: 5 }, () => call('household_context')));
    await expect(new LlmAgent(c.hub).run(packet, () => ({}), AbortSignal.timeout(1000))).rejects.toThrow('AGENT_TOOL_LIMIT');
  });
  it('maps provider failures to stable agent codes', async () => {
    for (const [status, code] of [[429, 'AGENT_RATE_LIMITED'], [400, 'AGENT_REQUEST_INVALID'], [500, 'AGENT_PROVIDER_FAILED']] as const) {
      const hub = staticHub(new OpenAiResponsesProvider({ apiKey: 'k', fetch: (async () => Response.json({ error: { message: 'private marker' } }, { status })) as unknown as typeof fetch }), { main: 'test' });
      await expect(new LlmAgent(hub).run(packet, () => ({}), AbortSignal.timeout(1000))).rejects.toThrow(new RegExp(`^${code}$`));
    }
  });
});

describe('agent on an OpenAI-compatible provider', () => {
  function compatible(responses: unknown[]) {
    const bodies: Array<{ messages: Array<Record<string, unknown>>; tools?: Array<{ function: { name: string } }>; [key: string]: unknown }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return Response.json(responses.shift()); });
    return { bodies, hub: staticHub(new OpenAiCompatibleProvider({ id: 'ollama', baseUrl: 'http://localhost:11434/v1', fetch: fetchImpl as unknown as typeof fetch }), { main: 'llama-test' }) };
  }
  const toolCall = (name: string) => ({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: '{}' } }] } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
  const final = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...parsed, items: [{ intent: 'direct', kind: 'grocery', title: 'Apples', quantity: '6', start: null, end: null, location: null, notes: null }] }) } }], usage: { prompt_tokens: 9, completion_tokens: 4 } };

  it('runs the tool loop through Chat Completions messages', async () => {
    const c = compatible([toolCall('household_context'), final]);
    const output = await new LlmAgent(c.hub).run(packet, () => ({ groceries: [] }), AbortSignal.timeout(1000));
    expect(output.result.items).toEqual([expect.objectContaining({ title: 'Apples', intent: 'direct' })]);
    expect(output.metrics).toMatchObject({ provider: 'ollama', model: 'llama-test', inputTokens: 16, outputTokens: 7, tools: ['household_context'] });
    expect(c.bodies[1]!.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(c.bodies[1]!.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"groceries":[]}' });
  });

  it('does not offer public_lookup when the provider has no web search', async () => {
    const c = compatible([final]);
    await new LlmAgent(c.hub).run(packet, () => ({}), AbortSignal.timeout(1000));
    expect(c.bodies[0]!.tools!.map((tool) => tool.function.name)).toEqual(['household_context', 'read_shared_document']);
    const asked = compatible([toolCall('public_lookup')]);
    await expect(new LlmAgent(asked.hub).run(packet, () => ({}), AbortSignal.timeout(1000))).rejects.toThrow('AGENT_UNKNOWN_TOOL');
  });
});
