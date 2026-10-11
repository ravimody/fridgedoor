import { zodTextFormat } from 'openai/helpers/zod';
import type { ZodType } from 'zod';
import { llmError } from './types.js';

type Json = Record<string, unknown>;

/** Strict JSON Schema as OpenAI Structured Outputs expects it (OpenAPI-style `nullable`). */
export function strictSchema(schema: ZodType, name: string): Json {
  return zodTextFormat(schema, name).schema as Json;
}

/**
 * Standard JSON Schema for other providers: turns `nullable: true` into a real null
 * type, and optionally drops keywords that some providers reject.
 */
export function portableSchema(schema: ZodType, name: string, options: { dropAdditionalProperties?: boolean } = {}): Json {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    const out: Json = {};
    for (const [key, value] of Object.entries(node as Json)) {
      if (key === '$schema' || key === 'nullable') continue;
      if (key === 'additionalProperties' && options.dropAdditionalProperties) continue;
      out[key] = visit(value);
    }
    if (!(node as Json).nullable) return out;
    if (typeof out.type === 'string') {
      const enumValues = Array.isArray(out.enum) ? { enum: [...out.enum, null] } : {};
      return { ...out, type: [out.type, 'null'], ...enumValues };
    }
    return { anyOf: [out, { type: 'null' }] };
  };
  return visit(strictSchema(schema, name)) as Json;
}

/** Pulls a JSON value out of model text, tolerating code fences and surrounding prose. */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced ? fenced[1]! : trimmed;
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (start >= 0 && end > start) { try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* fall through */ } }
  throw llmError('AI_OUTPUT_INVALID_JSON');
}

export function parseWithSchema<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw llmError('AI_OUTPUT_SCHEMA_INVALID');
  return parsed.data;
}

/** Drops nulls recursively: strict wire schemas use null where the domain uses an absent field. */
export function omitNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNulls);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, omitNulls(item)]));
  return value;
}
