import type { StructuredOutputMode } from './openai-compatible.js';
import type { LlmCapabilities } from './types.js';

export type ProviderKind = 'openai' | 'anthropic' | 'openai-compatible';

export type ProviderPreset = {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl?: string;
  /** False for local servers such as Ollama. */
  needsApiKey: boolean;
  /** Where people create a key; shown in setup. */
  keyUrl?: string;
  /** Model IDs we know work well; setup still lists the provider's live catalog. */
  suggested?: { main?: string; email?: string };
  structuredOutput?: StructuredOutputMode;
  dropAdditionalProperties?: boolean;
  reasoningEffortParam?: boolean;
  capabilities?: Partial<LlmCapabilities>;
  headers?: Record<string, string>;
  note?: string;
};

// Adding a provider that speaks OpenAI Chat Completions is one entry here; `custom`
// covers anything not listed (vLLM, LiteLLM, a corporate gateway...).
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI (GPT)', kind: 'openai', needsApiKey: true, keyUrl: 'https://platform.openai.com/api-keys', suggested: { main: 'gpt-6-luna', email: 'gpt-6-luna' } },
  { id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', needsApiKey: true, keyUrl: 'https://console.anthropic.com/settings/keys', suggested: { main: 'claude-sonnet-5-5', email: 'claude-haiku-5-5' } },
  { id: 'gemini', label: 'Google Gemini', kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsApiKey: true, keyUrl: 'https://aistudio.google.com/apikey', dropAdditionalProperties: true, reasoningEffortParam: true },
  { id: 'openrouter', label: 'OpenRouter (hundreds of models, one key)', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', needsApiKey: true, keyUrl: 'https://openrouter.ai/settings/keys', capabilities: { pdf: true }, headers: { 'x-title': 'Fridgedoor' }, note: 'Pick a model that supports structured outputs and tool calling.' },
  { id: 'groq', label: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', needsApiKey: true, keyUrl: 'https://console.groq.com/keys', capabilities: { transcription: true }, reasoningEffortParam: true },
  { id: 'mistral', label: 'Mistral', kind: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', needsApiKey: true, keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', needsApiKey: true, keyUrl: 'https://platform.deepseek.com/api_keys', structuredOutput: 'json_object', capabilities: { images: false } },
  { id: 'xai', label: 'xAI (Grok)', kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', needsApiKey: true, keyUrl: 'https://console.x.ai', reasoningEffortParam: true },
  { id: 'together', label: 'Together AI', kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', needsApiKey: true, keyUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'fireworks', label: 'Fireworks AI', kind: 'openai-compatible', baseUrl: 'https://api.fireworks.ai/inference/v1', needsApiKey: true, keyUrl: 'https://fireworks.ai/account/api-keys' },
  { id: 'azure-openai', label: 'Azure OpenAI', kind: 'openai', needsApiKey: true, note: 'Base URL is https://<resource>.openai.azure.com/openai/v1 and the model is your deployment name.' },
  { id: 'ollama', label: 'Ollama (runs on your own computer)', kind: 'openai-compatible', baseUrl: 'http://host.docker.internal:11434/v1', needsApiKey: false, note: 'Use a model with tool calling and vision for the best results. Small local models miss details in long emails.' },
  { id: 'lmstudio', label: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://host.docker.internal:1234/v1', needsApiKey: false },
  { id: 'llamacpp', label: 'llama.cpp server', kind: 'openai-compatible', baseUrl: 'http://host.docker.internal:8080/v1', needsApiKey: false, note: 'Start llama-server with --jinja so tool calling works.' },
  { id: 'vllm', label: 'vLLM', kind: 'openai-compatible', baseUrl: 'http://host.docker.internal:8000/v1', needsApiKey: false },
  { id: 'custom', label: 'Other OpenAI-compatible API', kind: 'openai-compatible', needsApiKey: false, note: 'Any server that implements /v1/chat/completions (vLLM, LiteLLM, a gateway...).' },
];

export function presetFor(id: string): ProviderPreset | undefined { return PROVIDER_PRESETS.find((preset) => preset.id === id); }
