import { requestJson, dataUrl, trimSlash, type FetchLike } from './http.js';
import { parseJsonText, parseWithSchema, strictSchema } from './schema.js';
import { errorForStatus, llmError, type GenerateRequest, type GenerateResult, type LlmCapabilities, type LlmMessage, type LlmProvider, type LlmToolCall, type LlmUsage, type WebSearchRequest, type WebSearchResult } from './types.js';

type Item = Record<string, unknown>;
export type OpenAiOptions = { id?: string; apiKey?: string; baseUrl?: string; headers?: Record<string, string>; fetch?: FetchLike; capabilities?: Partial<LlmCapabilities> };

/** OpenAI Responses API: strict Structured Outputs, function tools, hosted web search, inline images and PDFs. */
export class OpenAiResponsesProvider implements LlmProvider {
  readonly id: string;
  readonly capabilities: LlmCapabilities;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  constructor(private readonly options: OpenAiOptions) {
    this.id = options.id ?? 'openai';
    this.baseUrl = trimSlash(options.baseUrl ?? 'https://api.openai.com/v1');
    this.fetchImpl = options.fetch ?? fetch;
    this.capabilities = { images: true, pdf: true, tools: true, webSearch: true, reasoning: true, transcription: true, ...options.capabilities };
  }

  /** Models that rejected the `reasoning` parameter (older or non-reasoning models). */
  private readonly noReasoning = new Set<string>();

  /** Sends a Responses request; if the model rejects `reasoning`, retries once without it and remembers that. */
  private async respond(body: Record<string, unknown>, signal: AbortSignal) {
    const model = String(body.model);
    if (this.noReasoning.has(model)) { const { reasoning: _skip, ...rest } = body; void _skip; body = rest; }
    try { return await requestJson(this.fetchImpl, `${this.baseUrl}/responses`, { headers: this.headers(), body, signal }); }
    catch (error) {
      if (!(error instanceof Error && error.message === 'AI_REQUEST_INVALID' && 'reasoning' in body)) throw error;
      const { reasoning: _skip, ...rest } = body; void _skip;
      const response = await requestJson(this.fetchImpl, `${this.baseUrl}/responses`, { headers: this.headers(), body: rest, signal });
      this.noReasoning.add(model);
      return response;
    }
  }

  private headers(): Record<string, string> { return { ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}), ...this.options.headers }; }

  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const body = {
      model: request.model, store: false, instructions: request.system, input: request.messages.flatMap(toInput),
      text: { format: { type: 'json_schema', name: request.schemaName, strict: true, schema: strictSchema(request.schema, request.schemaName) } },
      ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.parameters.additionalProperties === false })), parallel_tool_calls: false } : {}),
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
      ...(request.reasoning ? { reasoning: { effort: request.reasoning } } : {}),
    };
    const response = await this.respond(body, request.signal);
    checkStatus(response);
    const output = (response.output as Item[] | undefined) ?? [];
    const usage = usageOf(response);
    const model = String(response.model ?? request.model);
    const requestId = typeof response.id === 'string' ? response.id : undefined;
    const calls: LlmToolCall[] = output.filter((item) => item.type === 'function_call').map((item) => ({ id: String(item.call_id), name: String(item.name), arguments: String(item.arguments ?? '{}') }));
    if (calls.length) {
      // Reasoning items must be sent back with their function calls on the next turn.
      const replay = output.filter((item) => item.type === 'reasoning' || item.type === 'function_call').map((item) => item.type === 'function_call' ? { type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments } : item);
      return { type: 'tool_calls', calls, assistant: { role: 'assistant', toolCalls: calls, replay }, usage, model, ...(requestId ? { requestId } : {}) };
    }
    const text = outputText(output);
    return { type: 'object', object: parseWithSchema(request.schema, parseJsonText(text)), usage, model, ...(requestId ? { requestId } : {}) };
  }

  async webSearch(request: WebSearchRequest): Promise<WebSearchResult> {
    const response = await this.respond({
      model: request.model, store: false, instructions: request.instructions, input: request.query,
      tools: [{ type: 'web_search' }], tool_choice: 'required', max_tool_calls: 2, max_output_tokens: request.maxOutputTokens ?? 3000,
      ...(request.reasoning ? { reasoning: { effort: request.reasoning } } : {}),
    }, request.signal);
    checkStatus(response);
    const output = (response.output as Item[] | undefined) ?? [];
    const sources = output.filter((item) => item.type === 'message').flatMap((item) => (item.content as Item[] | undefined) ?? [])
      .flatMap((part) => (part.annotations as Item[] | undefined) ?? []).filter((note) => note.type === 'url_citation').map((note) => String(note.url));
    return { text: outputText(output), sources: [...new Set(sources)].slice(0, 12), usage: usageOf(response), searches: output.filter((item) => item.type === 'web_search_call').length };
  }

  async transcribe(file: File, model: string, signal: AbortSignal): Promise<string> {
    return transcribeOpenAiStyle(this.fetchImpl, `${this.baseUrl}/audio/transcriptions`, this.headers(), file, model, signal);
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    const response = await requestJson(this.fetchImpl, `${this.baseUrl}/models`, { method: 'GET', headers: this.headers(), signal, timeoutMs: 20_000 });
    return ((response.data as Item[] | undefined) ?? []).map((model) => String(model.id)).sort();
  }
}

function toInput(message: LlmMessage): Item[] {
  if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.callId, output: message.output }];
  if (message.role === 'assistant') return Array.isArray(message.replay) ? message.replay as Item[] : message.toolCalls.map((call) => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }));
  return [{ role: 'user', content: message.content.map((part) => part.type === 'text' ? { type: 'input_text', text: part.text }
    : part.type === 'image' ? { type: 'input_image', image_url: dataUrl(part.mimeType, part.base64), detail: part.detail ?? 'auto' }
    : { type: 'input_file', filename: part.filename ?? 'document.pdf', file_data: dataUrl('application/pdf', part.base64) }) }];
}

function checkStatus(response: Record<string, unknown>) {
  if (response.status === 'incomplete') throw llmError((response.incomplete_details as Item | undefined)?.reason === 'max_output_tokens' ? 'AI_OUTPUT_LIMIT' : 'AI_OUTPUT_INCOMPLETE');
  if (response.status !== 'completed') throw llmError('AI_RESPONSE_FAILED');
  const output = (response.output as Item[] | undefined) ?? [];
  if (output.some((item) => item.type === 'message' && ((item.content as Item[] | undefined) ?? []).some((part) => part.type === 'refusal'))) throw llmError('AI_REFUSED');
}

function outputText(output: Item[]) {
  const text = output.filter((item) => item.type === 'message').flatMap((item) => (item.content as Item[] | undefined) ?? []).filter((part) => part.type === 'output_text').map((part) => String(part.text ?? '')).join('');
  if (!text) throw llmError('AI_OUTPUT_EMPTY');
  return text;
}

function usageOf(response: Record<string, unknown>): LlmUsage {
  const usage = response.usage as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } | undefined;
  return { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0, ...(usage?.output_tokens_details?.reasoning_tokens === undefined ? {} : { reasoningTokens: usage.output_tokens_details.reasoning_tokens }),
    ...(usage?.input_tokens_details?.cached_tokens === undefined ? {} : { cachedInputTokens: usage.input_tokens_details.cached_tokens }) };
}

const AUDIO_EXTENSIONS: Record<string, string> = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };

/** `/audio/transcriptions` as implemented by OpenAI, Groq and other compatible servers. */
export async function transcribeOpenAiStyle(fetchImpl: FetchLike, url: string, headers: Record<string, string>, file: File, model: string, signal: AbortSignal): Promise<string> {
  const extension = AUDIO_EXTENSIONS[file.type.split(';')[0]!] ?? 'webm';
  const body = new FormData();
  body.set('file', file, `recording.${extension}`);
  body.set('model', model);
  body.set('response_format', 'json');
  let response: Response;
  try { response = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]) }); }
  catch { throw llmError(signal.aborted ? 'AI_CANCELLED' : 'AI_RETRYABLE'); }
  if (!response.ok) throw llmError(errorForStatus(response.status));
  const parsed = await response.json().catch(() => undefined) as { text?: unknown } | undefined;
  const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
  if (!text) throw llmError('AI_OUTPUT_EMPTY');
  return text.slice(0, 8000);
}
