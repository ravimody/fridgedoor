import { transcribeOpenAiStyle } from './openai.js';
import { requestJson, dataUrl, trimSlash, type FetchLike } from './http.js';
import { parseJsonText, portableSchema } from './schema.js';
import { llmError, type GenerateRequest, type GenerateResult, type LlmCapabilities, type LlmMessage, type LlmProvider, type LlmToolCall, type LlmUsage } from './types.js';

type Item = Record<string, unknown>;

/**
 * How the endpoint can be asked for JSON:
 * - `json_schema`: `response_format.json_schema` (OpenAI, Gemini, Mistral, Ollama, vLLM, OpenRouter for most models)
 * - `json_object`: JSON mode without a schema; the schema goes in the prompt (DeepSeek and older servers)
 * - `prompt`: no response_format at all; the schema goes in the prompt
 */
export type StructuredOutputMode = 'json_schema' | 'json_object' | 'prompt';

export type OpenAiCompatibleOptions = {
  id: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  structuredOutput?: StructuredOutputMode;
  /** Some servers (Gemini) reject `additionalProperties` in response schemas. */
  dropAdditionalProperties?: boolean;
  /** Send `reasoning_effort` when the caller asks for some reasoning; `none` is omitted, since not every server accepts it. */
  reasoningEffortParam?: boolean;
  capabilities?: Partial<LlmCapabilities>;
  fetch?: FetchLike;
};

/** Any server that speaks OpenAI Chat Completions: OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Gemini, Ollama, LM Studio, vLLM... */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  readonly capabilities: LlmCapabilities;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly mode: StructuredOutputMode;
  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.baseUrl = trimSlash(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.mode = options.structuredOutput ?? 'json_schema';
    this.capabilities = { images: true, pdf: false, tools: true, webSearch: false, reasoning: Boolean(options.reasoningEffortParam), transcription: false, ...options.capabilities };
  }

  private headers(): Record<string, string> { return { ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}), ...this.options.headers }; }

  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const schema = portableSchema(request.schema, request.schemaName, { dropAdditionalProperties: this.options.dropAdditionalProperties ?? false });
    const schemaInstruction = this.mode === 'json_schema' ? '' : `\n\nReply with only a JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
    const messages: Item[] = [{ role: 'system', content: `${request.system}${schemaInstruction}` }, ...request.messages.flatMap((message) => this.toMessages(message))];
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    // Without server-side schema enforcement, give the model one chance to repair its JSON.
    const attempts = this.mode === 'json_schema' ? 1 : 2;
    for (let attempt = 1; ; attempt++) {
      const response = await requestJson(this.fetchImpl, `${this.baseUrl}/chat/completions`, { headers: this.headers(), signal: request.signal, body: {
        model: request.model, messages,
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(this.mode === 'json_schema' ? { response_format: { type: 'json_schema', json_schema: { name: request.schemaName, schema, strict: !this.options.dropAdditionalProperties } } } : this.mode === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
        ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })), tool_choice: 'auto' } : {}),
        ...(request.reasoning && request.reasoning !== 'none' && this.options.reasoningEffortParam ? { reasoning_effort: request.reasoning } : {}),
      } });
      const turn = usageOf(response); usage.inputTokens += turn.inputTokens; usage.outputTokens += turn.outputTokens;
      if (turn.reasoningTokens !== undefined) usage.reasoningTokens = (usage.reasoningTokens ?? 0) + turn.reasoningTokens;
      const choice = ((response.choices as Item[] | undefined) ?? [])[0];
      const message = (choice?.message as Item | undefined) ?? {};
      const model = String(response.model ?? request.model);
      const requestId = typeof response.id === 'string' ? response.id : undefined;
      if (choice?.finish_reason === 'length') throw llmError('AI_OUTPUT_LIMIT');
      if (typeof message.refusal === 'string' && message.refusal) throw llmError('AI_REFUSED');
      const calls: LlmToolCall[] = ((message.tool_calls as Item[] | undefined) ?? []).map((call) => { const fn = (call.function as Item | undefined) ?? {}; return { id: String(call.id ?? `call_${Math.random().toString(36).slice(2)}`), name: String(fn.name), arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) }; });
      if (calls.length) return { type: 'tool_calls', calls, assistant: { role: 'assistant', toolCalls: calls, ...(typeof message.content === 'string' && message.content ? { text: message.content } : {}) }, usage, model, ...(requestId ? { requestId } : {}) };
      const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? (message.content as Item[]).map((part) => String(part.text ?? '')).join('') : '';
      if (!text.trim()) throw llmError('AI_OUTPUT_EMPTY');
      let value: unknown;
      try { value = parseJsonText(text); } catch (error) { if (attempt >= attempts) throw error; messages.push({ role: 'assistant', content: text }, { role: 'user', content: 'That was not valid JSON. Reply with only the corrected JSON object.' }); continue; }
      const parsed = request.schema.safeParse(value);
      if (parsed.success) return { type: 'object', object: parsed.data, usage, model, ...(requestId ? { requestId } : {}) };
      if (attempt >= attempts) throw llmError('AI_OUTPUT_SCHEMA_INVALID');
      const problems = parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`).join('; ');
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `That JSON does not match the schema (${problems}). Reply with only the corrected JSON object.` });
    }
  }

  async transcribe(file: File, model: string, signal: AbortSignal): Promise<string> {
    if (!this.capabilities.transcription) throw llmError('AI_UNSUPPORTED');
    return transcribeOpenAiStyle(this.fetchImpl, `${this.baseUrl}/audio/transcriptions`, this.headers(), file, model, signal);
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    const response = await requestJson(this.fetchImpl, `${this.baseUrl}/models`, { method: 'GET', headers: this.headers(), signal, timeoutMs: 20_000 });
    const list = (response.data as Item[] | undefined) ?? (response.models as Item[] | undefined) ?? [];
    return list.map((model) => String(model.id ?? model.name)).filter(Boolean).sort();
  }

  private toMessages(message: LlmMessage): Item[] {
    if (message.role === 'tool') return [{ role: 'tool', tool_call_id: message.callId, content: message.output }];
    if (message.role === 'assistant') return [{ role: 'assistant', content: message.text ?? null, tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }];
    const content = message.content.map((part): Item => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'image') return this.capabilities.images ? { type: 'image_url', image_url: { url: dataUrl(part.mimeType, part.base64) } } : { type: 'text', text: '[An image was attached, but this model cannot read images.]' };
      return this.capabilities.pdf ? { type: 'file', file: { filename: part.filename ?? 'document.pdf', file_data: dataUrl('application/pdf', part.base64) } } : { type: 'text', text: '[A PDF was attached, but this model cannot read PDFs.]' };
    });
    // Plain string content is the most widely accepted form for text-only turns.
    return [{ role: 'user', content: content.every((part) => part.type === 'text') ? content.map((part) => part.text).join('\n\n') : content }];
  }
}

function usageOf(response: Record<string, unknown>): LlmUsage {
  const usage = response.usage as { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
  return { inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0, ...(usage?.completion_tokens_details?.reasoning_tokens === undefined ? {} : { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }) };
}
