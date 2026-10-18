import type { Context, ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

// Domain errors are thrown as `new Error('SOME_CODE')`. Anything else (a TypeError, a
// database error) is a bug: the client gets INTERNAL and the server log gets the stack.
const CODED = /^[A-Z][A-Z0-9_]{1,63}$/;
type Env = { Variables: { requestId: string } };

/** The error's client-facing code, or undefined when it is an unexpected failure. */
export function errorCode(error: unknown): string | undefined {
  if (error instanceof ZodError || error instanceof SyntaxError) return 'VALIDATION';
  return error instanceof Error && error.name === 'Error' && CODED.test(error.message) ? error.message : undefined;
}

/** The one error body every endpoint returns. */
export function errorBody<E extends Env>(c: Context<E>, code: string, message = code.replaceAll('_', ' ').toLowerCase()) {
  return { error: { code, message, requestId: (c.get('requestId') as string | undefined) ?? crypto.randomUUID() } };
}

/** Logs an unexpected failure without request bodies, query strings or tokens in the path. */
export function logInternalError<E extends Env>(c: Context<E>, error: unknown) {
  const stack = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error);
  console.error(JSON.stringify({ level: 'error', code: 'INTERNAL', requestId: c.get('requestId'), method: c.req.method, route: c.req.routePath, stack }));
}

export function internalError<E extends Env>(c: Context<E>, error: unknown) {
  logInternalError(c, error);
  return c.json(errorBody(c, 'INTERNAL', 'Something went wrong. Try again in a moment.'), 500);
}

const HTTP_CODES: Record<number, string> = { 400: 'VALIDATION', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 413: 'PAYLOAD_TOO_LARGE', 429: 'TOO_MANY_ATTEMPTS' };

/**
 * Shared `onError` for the root app and sub-apps. Coded errors keep their code, with the
 * status from `statuses` (default `fallback`); unknown errors become a logged 500.
 */
export function errorHandler<E extends Env>(statuses: Record<string, ContentfulStatusCode> = {}, fallback: ContentfulStatusCode = 400): ErrorHandler<E> {
  return (error, c) => {
    if (error instanceof HTTPException) { const status = error.status as ContentfulStatusCode; return c.json(errorBody(c, HTTP_CODES[status] ?? `HTTP_${status}`), status); }
    const code = errorCode(error);
    if (!code) return internalError(c, error);
    return c.json(errorBody(c, code), statuses[code] ?? fallback);
  };
}

/** Status codes for coded errors raised outside a sub-app's own handler. */
export const ROOT_STATUSES: Record<string, ContentfulStatusCode> = { VALIDATION: 422, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, STALE_REVISION: 409, CAPTURE_TOO_LARGE: 413, PAYLOAD_TOO_LARGE: 413 };

/** Rethrows unexpected errors so the root handler logs them; returns the code otherwise. Used by routes with their own status mapping. */
export function codeOrThrow(error: unknown): string {
  const code = errorCode(error);
  if (!code) throw error;
  return code;
}
