import type Database from 'better-sqlite3';
import { z } from 'zod';
import { configSchema, type AppConfig } from './config.js';
import { decryptJson, encryptJson, keyFromSecret, type Envelope } from './crypto.js';
import { LlmHub, type AiConfig } from './llm/hub.js';

// Model roles: `main` (assistant, briefs, knowledge upkeep); `email` (reads incoming
// mail, defaults to main); `review` (optional: stronger model that extracts plans from
// the emails the email model flags as worth reading); `transcribe` (speech to text).
export const aiSettingsSchema = z.object({
  provider: z.string().min(1).max(40),
  apiKey: z.string().max(500).optional(),
  baseUrl: z.string().url().max(500).optional(),
  structuredOutput: z.enum(['json_schema', 'json_object', 'prompt']).optional(),
  models: z.object({ main: z.string().max(200).optional(), email: z.string().max(200).optional(), review: z.string().max(200).optional(), transcribe: z.string().max(200).optional() }),
}).strict();
export const vapidSettingsSchema = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) }).strict();
export const googleSettingsSchema = z.object({ clientId: z.string().min(1).max(300), clientSecret: z.string().min(1).max(300) }).strict();

const schemas = { ai: aiSettingsSchema, public_url: z.string().url(), vapid: vapidSettingsSchema, google_oauth: googleSettingsSchema, setup_token: z.string().min(16) };
export type SettingName = keyof typeof schemas;
type SettingValue<N extends SettingName> = z.infer<(typeof schemas)[N]>;

/** Encrypted key/value settings. Reads hit SQLite each time, so the API and worker see changes immediately. */
export class SettingsStore {
  private readonly key: Buffer;
  constructor(private readonly db: Database.Database, secret: string, private readonly clock: () => Date = () => new Date()) { this.key = keyFromSecret(`settings:${secret}`); }

  get<N extends SettingName>(name: N): SettingValue<N> | undefined {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE name = ?').get(name) as { value: string } | undefined;
    if (!row) return undefined;
    try { return schemas[name].parse(decryptJson(JSON.parse(row.value) as Envelope, this.key, `setting:${name}`)) as SettingValue<N>; } catch { return undefined; }
  }

  set<N extends SettingName>(name: N, value: SettingValue<N>) {
    const parsed = schemas[name].parse(value);
    this.db.prepare('INSERT INTO app_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(name, JSON.stringify(encryptJson(parsed, this.key, `setting:${name}`)), this.clock().toISOString());
  }

  delete(name: SettingName) { this.db.prepare('DELETE FROM app_settings WHERE name = ?').run(name); }
}

/** True when AI settings come from environment variables (the web app then shows them read-only). */
export function aiFromEnv(config: AppConfig) { return Boolean(config.AI_PROVIDER); }

/** AI settings: environment first (including the older OPENAI_/ANTHROPIC_ names), then the web app's saved settings. */
export function resolveAiConfig(config: AppConfig, settings?: SettingsStore): AiConfig | undefined {
  if (config.AI_PROVIDER) {
    const provider = config.AI_PROVIDER;
    const apiKey = config.AI_API_KEY ?? (provider === 'openai' ? config.OPENAI_API_KEY : provider === 'anthropic' ? config.ANTHROPIC_API_KEY : undefined);
    const main = config.AI_MODEL ?? config.AI_MODEL_CHAT ?? config.AI_MODEL_EXTRACT;
    const email = config.AI_MODEL_EMAIL ?? config.AI_MODEL_EXTRACT;
    return {
      provider, ...(apiKey ? { apiKey } : {}), ...(config.AI_BASE_URL ? { baseUrl: config.AI_BASE_URL } : {}), ...(config.AI_STRUCTURED_OUTPUT ? { structuredOutput: config.AI_STRUCTURED_OUTPUT } : {}),
      models: { ...(main ? { main } : {}), ...(email ? { email } : {}), ...(config.AI_MODEL_REVIEW ? { review: config.AI_MODEL_REVIEW } : {}), ...(config.AI_MODEL_TRANSCRIBE ? { transcribe: config.AI_MODEL_TRANSCRIBE } : {}) },
    };
  }
  const saved = settings?.get('ai');
  if (!saved) return undefined;
  return { provider: saved.provider, ...(saved.apiKey ? { apiKey: saved.apiKey } : {}), ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}), ...(saved.structuredOutput ? { structuredOutput: saved.structuredOutput } : {}), models: Object.fromEntries(Object.entries(saved.models).filter(([, value]) => value)) as AiConfig['models'] };
}

/**
 * AI settings for operator scripts, from environment variables only: no database and
 * no data directory. `model`, when given, overrides every text role.
 */
export function scriptAi(model?: string, env: NodeJS.ProcessEnv = process.env) {
  const config: AppConfig = { ...configSchema.parse(env), DATABASE_PATH: '', SESSION_SECRET: '', APP_ORIGIN: '' };
  const ai = resolveAiConfig(config);
  const models = model ? { main: model, email: model } : {};
  return { config, hub: new LlmHub(() => ai && { ...ai, models: { ...ai.models, ...models } }) };
}
