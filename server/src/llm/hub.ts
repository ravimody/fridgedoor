import { AnthropicProvider } from './anthropic.js';
import type { FetchLike } from './http.js';
import { OpenAiCompatibleProvider, type StructuredOutputMode } from './openai-compatible.js';
import { OpenAiResponsesProvider } from './openai.js';
import { presetFor } from './presets.js';
import type { LlmProvider } from './types.js';

/**
 * The household's model configuration. `main` drives the assistant, briefs and
 * knowledge upkeep; `email` (defaults to `main`) reads incoming mail; `review`, when
 * set, is the stronger model that extracts plans from the emails the email model
 * flags as worth reading (the email model then only screens each message).
 */
export type AiConfig = {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  structuredOutput?: StructuredOutputMode;
  models: { main?: string | undefined; email?: string | undefined; review?: string | undefined; transcribe?: string | undefined };
};
export type ModelRole = 'main' | 'email' | 'review' | 'transcribe';
export type ResolvedModel = { provider: LlmProvider; model: string };

const DEFAULT_TRANSCRIBE: Record<string, string> = { openai: 'gpt-4o-mini-transcribe', groq: 'whisper-large-v3-turbo' };

export function createProvider(config: AiConfig, fetchImpl?: FetchLike): LlmProvider {
  const preset = presetFor(config.provider) ?? presetFor('custom')!;
  const baseUrl = config.baseUrl || preset.baseUrl;
  const shared = { ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(preset.capabilities ? { capabilities: preset.capabilities } : {}) };
  if (preset.kind === 'anthropic') return new AnthropicProvider({ apiKey: config.apiKey ?? '', ...(baseUrl ? { baseUrl } : {}), ...shared });
  if (preset.kind === 'openai') {
    // Azure authenticates API keys with an `api-key` header instead of a bearer token.
    const azure = preset.id === 'azure-openai';
    return new OpenAiResponsesProvider({ id: preset.id, ...(azure ? { headers: { 'api-key': config.apiKey ?? '' } } : config.apiKey ? { apiKey: config.apiKey } : {}), ...(baseUrl ? { baseUrl } : {}), ...shared });
  }
  if (!baseUrl) throw new Error('AI_NOT_CONFIGURED');
  return new OpenAiCompatibleProvider({
    id: preset.id, baseUrl, ...(config.apiKey ? { apiKey: config.apiKey } : {}), ...(preset.headers ? { headers: preset.headers } : {}),
    structuredOutput: config.structuredOutput ?? preset.structuredOutput ?? 'json_schema',
    dropAdditionalProperties: preset.dropAdditionalProperties ?? false, reasoningEffortParam: preset.reasoningEffortParam ?? false, ...shared,
  });
}

/**
 * Resolves the configured provider and model at call time, so changing the AI
 * settings in the web app takes effect without restarting the server or worker.
 */
export class LlmHub {
  private cached?: { key: string; provider: LlmProvider };
  /** `options.provider` pins a provider instance (tests and evaluation scripts). */
  constructor(private readonly load: () => AiConfig | undefined, private readonly options: { fetch?: FetchLike; provider?: LlmProvider } = {}) {}

  config(): AiConfig | undefined {
    const config = this.load();
    if (!config?.provider || !config.models.main) return undefined;
    const preset = presetFor(config.provider);
    if (!this.options.provider && preset?.needsApiKey && !config.apiKey) return undefined;
    return config;
  }

  provider(): LlmProvider | undefined {
    const config = this.config();
    if (!config) return undefined;
    if (this.options.provider) return this.options.provider;
    const key = JSON.stringify([config.provider, config.apiKey, config.baseUrl, config.structuredOutput]);
    if (this.cached?.key !== key) this.cached = { key, provider: createProvider(config, this.options.fetch) };
    return this.cached.provider;
  }

  model(role: ModelRole): string | undefined {
    const config = this.config();
    if (!config) return undefined;
    if (role === 'main') return config.models.main;
    if (role === 'email') return config.models.email || config.models.main;
    if (role === 'review') return config.models.review || undefined;
    return config.models.transcribe || DEFAULT_TRANSCRIBE[config.provider];
  }

  resolve(role: ModelRole): ResolvedModel | undefined {
    const provider = this.provider();
    const model = this.model(role);
    return provider && model ? { provider, model } : undefined;
  }

  configured() { return Boolean(this.config()); }
}

/** A hub with a fixed provider, for tests and evaluation scripts. */
export function staticHub(provider: LlmProvider, models: AiConfig['models']): LlmHub {
  return new LlmHub(() => ({ provider: provider.id, models }), { provider });
}

/** A value fixed at construction (tests) or read at call time (AI settings that can change while running). */
export type Lazy<T> = T | (() => T);
export function lazy<T>(value: Lazy<T>): T { return typeof value === 'function' ? (value as () => T)() : value; }
