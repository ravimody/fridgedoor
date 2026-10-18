import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { LlmHub } from '../llm/hub.js';
import type { LlmProvider } from '../llm/types.js';
import { resolveAiConfig } from '../settings.js';
import { backgroundAiEnabled, createAiProvider } from './ai.js';

const packet = { schemaVersion: 'v1', sourceVersionId: 'synthetic', timezone: 'America/New_York', ownerLabel: 'Owner', allowedParticipants: ['Owner'], allowedCategories: ['school'], text: 'School fair October 25', truncated: false };
const hubFor = (env: Record<string, string>) => { const config = loadConfig({ NODE_ENV: 'test', ...env }); return { config, hub: new LlmHub(() => resolveAiConfig(config)) }; };

describe('AI provider activation', () => {
  it('stays off without a model or a hosted provider key, and honors the kill switch', () => {
    const off = [{ AI_MODEL_EXTRACT: 'pinned-model' }, { AI_PROVIDER: 'anthropic', AI_MODEL_EXTRACT: 'pinned-model' }, { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', AI_MODEL: 'm', AI_ENABLED: 'false' }];
    for (const env of off) { const { config, hub } = hubFor(env); expect(backgroundAiEnabled(hub, config)).toBe(false); }
    const { config, hub } = hubFor({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', AI_MODEL: 'm' });
    expect(backgroundAiEnabled(hub, config)).toBe(true);
  });

  it('allows the deterministic fake provider without credentials and reserves budget for it', async () => {
    const { config, hub } = hubFor({ AI_PROVIDER: 'fake', AI_MODEL_EXTRACT: 'synthetic-v1' });
    expect(backgroundAiEnabled(hub, config)).toBe(true);
    const reserve = vi.fn();
    expect(await createAiProvider(hub, config).extract(packet, new AbortController().signal, reserve)).toMatchObject({ provider: 'fake', model: 'synthetic-v1' });
    expect(reserve).toHaveBeenCalledExactlyOnceWith('synthetic-v1');
  });

  it('resolves the provider and models when each extraction runs', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('AI_RATE_LIMITED'));
    const provider: LlmProvider = { id: 'synthetic', capabilities: { images: true, pdf: true, tools: true, webSearch: false, reasoning: false, transcription: false }, generate };
    let models: { main: string; email?: string; review?: string } = { main: 'first' };
    const hub = new LlmHub(() => ({ provider: provider.id, models }), { provider });
    const ai = createAiProvider(hub);
    await expect(ai.extract(packet, new AbortController().signal)).rejects.toThrow('AI_RETRYABLE');
    models = { main: 'first', email: 'second', review: 'stronger' };
    await expect(ai.extract(packet, new AbortController().signal)).rejects.toThrow('AI_RETRYABLE');
    expect(generate.mock.calls.map(([request]) => [request.model, request.schemaName])).toEqual([['first', 'household_extraction'], ['second', 'email_relevance']]);
  });

  it('screens with the email model and extracts with the stronger review model, keyed by the email model', async () => {
    const result = { decision: 'private', category: 'school', confidence: 0.7, uncertaintyReasons: [], privacyFlags: [], candidates: [] };
    const generate = vi.fn(async (request: { schemaName: string; model: string }) => ({ type: 'object', object: request.schemaName === 'email_relevance' ? { decision: 'review', confidence: 'high', reason: 'Synthetic' } : result, usage: { inputTokens: 1, outputTokens: 1 }, model: request.model }));
    const provider = { id: 'synthetic', capabilities: { images: true, pdf: true, tools: true, webSearch: false, reasoning: true, transcription: false }, generate } as unknown as LlmProvider;
    const hub = new LlmHub(() => ({ provider: provider.id, models: { main: 'main', email: 'cheap', review: 'strong' } }), { provider });
    const reserve = vi.fn();
    const value = await createAiProvider(hub).extract(packet, new AbortController().signal, reserve);
    expect(generate.mock.calls.map(([request]) => [request.model, request.schemaName, (request as { reasoning?: string }).reasoning])).toEqual([['cheap', 'email_relevance', 'high'], ['strong', 'household_extraction', 'low']]);
    expect(reserve.mock.calls).toEqual([['cheap'], ['strong']]);
    generate.mockClear();
    await createAiProvider(hub, { AI_EXTRACT_EFFORT: 'medium' }).extract(packet, new AbortController().signal, reserve);
    expect(generate.mock.calls.map(([request]) => (request as { reasoning?: string }).reasoning)).toEqual(['high', 'medium']);
    expect(value).toMatchObject({ model: 'cheap', usage: { stages: [{ model: 'cheap' }, { model: 'strong' }] } });
  });
});
