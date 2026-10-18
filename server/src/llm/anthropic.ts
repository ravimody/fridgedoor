import { requestJson, trimSlash, type FetchLike } from './http.js';
import { parseJsonText, parseWithSchema, portableSchema } from './schema.js';
import { llmError, type GenerateRequest, type GenerateResult, type LlmCapabilities, type LlmMessage, type LlmProvider, type LlmToolCall, type LlmUsage, type WebSearchRequest, type WebSearchResult } from './types.js';

type Block = Record<string, unknown>;
type Message = { role: 'user' | 'assistant'; content: Block[] };
export type AnthropicOptions = { apiKey: string; baseUrl?: string; fetch?: FetchLike; capabilities?: Partial<LlmCapabilities> };

const VERSION = '2023-06-01';
// The final answer arrives as a call to this tool; forcing a tool call is the most
// widely supported way to get schema-shaped output from Claude models.
const ANSWER_TOOL = 'final_answer';

/** Anthropic Messages API (Claude). */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly capabilities: LlmCapabilities;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  constructor(private readonly options: AnthropicOptions) {
    this.baseUrl = trimSlash(options.baseUrl ?? 'https://api.anthropic.com');
    this.fetchImpl = options.fetch ?? fetch;
    this.capabilities = { images: true, pdf: true, tools: true, webSearch: true, reasoning: false, transcription: false, ...options.capabilities };
  }

  private headers() { return { 'x-api-key': this.options.apiKey, 'anthropic-version': VERSION }; }

  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const tools = [
      ...(request.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
      { name: ANSWER_TOOL, description: `Return the final ${request.schemaName.replaceAll('_', ' ')} by calling this tool exactly once. Do not answer in plain text.`, input_schema: portableSchema(request.schema, request.schemaName) },
    ];
    const body = {
      model: request.model, max_tokens: request.maxOutputTokens ?? 4096, system: request.system, messages: toMessages(request.messages), tools,
      tool_choice: request.tools?.length ? { type: 'any', disable_parallel_tool_use: true } : { type: 'tool', name: ANSWER_TOOL },
    };
    const response = await requestJson(this.fetchImpl, `${this.baseUrl}/v1/messages`, { headers: this.headers(), body, signal: request.signal });
    if (response.stop_reason === 'max_tokens') throw llmError('AI_OUTPUT_LIMIT');
    if (response.stop_reason === 'refusal') throw llmError('AI_REFUSED');
    const content = (response.content as Block[] | undefined) ?? [];
    const usage = usageOf(response);
    const model = String(response.model ?? request.model);
    const requestId = typeof response.id === 'string' ? response.id : undefined;
    const answer = content.find((block) => block.type === 'tool_use' && block.name === ANSWER_TOOL);
    if (answer) return { type: 'object', object: parseWithSchema(request.schema, answer.input), usage, model, ...(requestId ? { requestId } : {}) };
    const calls: LlmToolCall[] = content.filter((block) => block.type === 'tool_use').map((block) => ({ id: String(block.id), name: String(block.name), arguments: JSON.stringify(block.input ?? {}) }));
    if (calls.length) return { type: 'tool_calls', calls, assistant: { role: 'assistant', toolCalls: calls, replay: content }, usage, model, ...(requestId ? { requestId } : {}) };
    const text = content.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('');
    if (!text) throw llmError('AI_OUTPUT_EMPTY');
    return { type: 'object', object: parseWithSchema(request.schema, parseJsonText(text)), usage, model, ...(requestId ? { requestId } : {}) };
  }

  async webSearch(request: WebSearchRequest): Promise<WebSearchResult> {
    const response = await requestJson(this.fetchImpl, `${this.baseUrl}/v1/messages`, { headers: this.headers(), signal: request.signal, body: {
      model: request.model, max_tokens: request.maxOutputTokens ?? 3000, system: request.instructions,
      messages: [{ role: 'user', content: request.query }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    } });
    const content = (response.content as Block[] | undefined) ?? [];
    const text = content.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('');
    if (!text) throw llmError('AI_OUTPUT_EMPTY');
    const cited = content.flatMap((block) => (block.citations as Block[] | undefined) ?? []).map((citation) => citation.url).filter((url): url is string => typeof url === 'string');
    const searches = Number((response.usage as { server_tool_use?: { web_search_requests?: number } } | undefined)?.server_tool_use?.web_search_requests ?? content.filter((block) => block.type === 'server_tool_use').length);
    return { text, sources: [...new Set(cited)].slice(0, 12), usage: usageOf(response), searches };
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    const response = await requestJson(this.fetchImpl, `${this.baseUrl}/v1/models?limit=100`, { method: 'GET', headers: this.headers(), signal, timeoutMs: 20_000 });
    return ((response.data as Block[] | undefined) ?? []).map((model) => String(model.id)).sort();
  }
}

/** Claude needs alternating turns, with tool results inside a user turn. */
function toMessages(messages: LlmMessage[]): Message[] {
  const out: Message[] = [];
  const push = (role: Message['role'], blocks: Block[]) => { const last = out.at(-1); if (last?.role === role) last.content.push(...blocks); else out.push({ role, content: blocks }); };
  for (const message of messages) {
    if (message.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: message.callId, content: message.output }]);
    else if (message.role === 'assistant') push('assistant', Array.isArray(message.replay) ? message.replay as Block[] : message.toolCalls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: safeJson(call.arguments) })));
    else push('user', message.content.map((part) => part.type === 'text' ? { type: 'text', text: part.text }
      : part.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.base64 } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: part.base64 } }));
  }
  return out;
}

function safeJson(text: string) { try { return JSON.parse(text) as unknown; } catch { return {}; } }

function usageOf(response: Record<string, unknown>): LlmUsage {
  const usage = response.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
  return { inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0), outputTokens: usage?.output_tokens ?? 0, ...(usage?.cache_read_input_tokens === undefined ? {} : { cachedInputTokens: usage.cache_read_input_tokens }) };
}
