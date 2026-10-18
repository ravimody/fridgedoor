import { errorForStatus, llmError } from './types.js';

export type FetchLike = typeof fetch;

/** `cause` of an AI_RETRYABLE error when the request never reached a server (refused, unknown host). */
export const UNREACHABLE = 'unreachable';

/** One request with a timeout, mapping every failure to a stable code. Response bodies never leak into errors. */
export async function requestJson(fetchImpl: FetchLike, url: string, init: { method?: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown; signal: AbortSignal; timeoutMs?: number }): Promise<Record<string, unknown>> {
  const signal = AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? 120_000)]);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method ?? 'POST', signal,
      headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    if (init.signal.aborted) throw llmError('AI_CANCELLED');
    // Retryable either way; the cause lets a connection test say that nothing answered rather than "busy".
    const error = llmError('AI_RETRYABLE'); if (!signal.aborted) error.cause = UNREACHABLE; throw error;
  }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw llmError(errorForStatus(response.status)); }
  try { return await response.json() as Record<string, unknown>; } catch { throw llmError('AI_RETRYABLE'); }
}

export function dataUrl(mimeType: string, base64: string) { return `data:${mimeType};base64,${base64}`; }

export function trimSlash(url: string) { return url.replace(/\/+$/, ''); }
