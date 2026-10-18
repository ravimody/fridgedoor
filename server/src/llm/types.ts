import type { ZodType } from 'zod';

// Provider-neutral model interface. Every AI feature talks to `LlmProvider`; the
// adapters translate to one vendor wire format each (OpenAI Responses, Anthropic
// Messages, or any OpenAI-compatible Chat Completions endpoint).

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export type LlmPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'pdf'; base64: string; filename?: string };

export type LlmToolCall = { id: string; name: string; arguments: string };

export type LlmMessage =
  | { role: 'user'; content: LlmPart[] }
  // `replay` holds the adapter's own output items (for example OpenAI reasoning items)
  // so a tool loop can continue on the same provider without losing state.
  | { role: 'assistant'; toolCalls: LlmToolCall[]; text?: string; replay?: unknown }
  | { role: 'tool'; callId: string; name: string; output: string };

export type LlmTool = { name: string; description: string; parameters: Record<string, unknown> };

/** `inputTokens` includes cached input; `cachedInputTokens` is the cached share when the provider reports it. */
export type LlmUsage = { inputTokens: number; outputTokens: number; reasoningTokens?: number; cachedInputTokens?: number };

export type GenerateRequest<T> = {
  model: string;
  system: string;
  messages: LlmMessage[];
  /** Zod schema for the final answer. Write it the strict way: every field present, `.nullable()` for absent values. */
  schema: ZodType<T>;
  schemaName: string;
  tools?: LlmTool[];
  maxOutputTokens?: number;
  reasoning?: ReasoningEffort;
  signal: AbortSignal;
};

export type GenerateResult<T> =
  | { type: 'object'; object: T; usage: LlmUsage; model: string; requestId?: string }
  | { type: 'tool_calls'; calls: LlmToolCall[]; assistant: Extract<LlmMessage, { role: 'assistant' }>; usage: LlmUsage; model: string; requestId?: string };

export type WebSearchRequest = { model: string; instructions: string; query: string; maxOutputTokens?: number; reasoning?: ReasoningEffort; signal: AbortSignal };
export type WebSearchResult = { text: string; sources: string[]; usage: LlmUsage; searches: number };

export type LlmCapabilities = {
  images: boolean;
  pdf: boolean;
  tools: boolean;
  webSearch: boolean;
  reasoning: boolean;
  transcription: boolean;
};

export interface LlmProvider {
  /** Stable provider id such as `openai`, `anthropic` or a preset id like `openrouter`. */
  readonly id: string;
  readonly capabilities: LlmCapabilities;
  generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>>;
  webSearch?(request: WebSearchRequest): Promise<WebSearchResult>;
  transcribe?(file: File, model: string, signal: AbortSignal): Promise<string>;
  listModels?(signal: AbortSignal): Promise<string[]>;
}

// Errors carry only stable codes: provider messages can echo request content.
export const LLM_ERROR_CODES = [
  'AI_RETRYABLE', 'AI_RATE_LIMITED', 'AI_PROVIDER_FAILED', 'AI_AUTH_FAILED', 'AI_REQUEST_INVALID', 'AI_MODEL_NOT_FOUND',
  'AI_OUTPUT_LIMIT', 'AI_OUTPUT_INCOMPLETE', 'AI_RESPONSE_FAILED', 'AI_REFUSED', 'AI_OUTPUT_EMPTY',
  'AI_OUTPUT_INVALID_JSON', 'AI_OUTPUT_SCHEMA_INVALID', 'AI_CANCELLED', 'AI_UNSUPPORTED', 'AI_NOT_CONFIGURED',
] as const;
export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number];
export const llmError = (code: LlmErrorCode) => { const error = new Error(code); if (code === 'AI_CANCELLED') error.name = 'AbortError'; return error; };
export const isLlmErrorCode = (value: unknown): value is LlmErrorCode => typeof value === 'string' && (LLM_ERROR_CODES as readonly string[]).includes(value);

/** Maps an HTTP status from any provider to a stable code. */
export function errorForStatus(status: number): LlmErrorCode {
  if (status === 401 || status === 403) return 'AI_AUTH_FAILED';
  if (status === 404) return 'AI_MODEL_NOT_FOUND';
  if (status === 429) return 'AI_RATE_LIMITED';
  if (status === 408 || status === 409 || status >= 500) return 'AI_RETRYABLE';
  if (status === 400 || status === 413 || status === 422) return 'AI_REQUEST_INVALID';
  return 'AI_PROVIDER_FAILED';
}
