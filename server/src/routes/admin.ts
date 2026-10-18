import type { Context, Hono } from 'hono';
import { z, ZodError } from 'zod';
import type { Variables } from '../app.js';
import type { MemberRecord } from '../auth/access.js';
import type { AccountService } from '../auth/accounts.js';
import type { AppConfig } from '../config.js';
import { createProvider, type AiConfig } from '../llm/hub.js';
import { PROVIDER_PRESETS, presetFor } from '../llm/presets.js';
import { UNREACHABLE } from '../llm/http.js';
import { isLlmErrorCode } from '../llm/types.js';
import { aiFromEnv, aiSettingsSchema, googleSettingsSchema, resolveAiConfig, type SettingsStore } from '../settings.js';

type C = Context<{ Variables: Variables }>;
type Deps = { accounts: AccountService; settings: SettingsStore; config: AppConfig; fetch?: typeof fetch };

const fail = (c: C, status: 400 | 403 | 409 | 422, code: string) => c.json({ error: { code, message: code.replaceAll('_', ' ').toLowerCase(), requestId: c.get('requestId') } }, status, { 'Cache-Control': 'no-store' });
const aiInput = aiSettingsSchema.extend({ apiKey: z.string().max(500).optional(), keepApiKey: z.boolean().optional() });
/** Custom servers and Azure have no default address. */
const needsBaseUrl = (config: AiConfig) => { const preset = presetFor(config.provider); return Boolean(preset && !preset.baseUrl && !config.baseUrl && (preset.kind === 'openai-compatible' || preset.id === 'azure-openai')); };
const pingSchema = z.object({ ok: z.boolean() }).strict();

/** Server settings for the household's owners: AI provider and models, public address, Google sign-in. */
export function registerAdminRoutes(app: Hono<{ Variables: Variables }>, deps: Deps) {
  const owner = (c: C) => { const member = (c.get('session') as { member: MemberRecord }).member; return deps.accounts.canManage(member) ? member : undefined; };
  const currentAi = () => resolveAiConfig(deps.config, deps.settings);
  // A blank key in the form means "keep the saved one", but only for the same provider at
  // the same address: the saved key must never be sent to a server the form just named.
  const withKey = (input: z.infer<typeof aiInput>): AiConfig => {
    const saved = currentAi();
    const sameEndpoint = saved?.provider === input.provider && (saved.baseUrl ?? '') === (input.baseUrl ?? '');
    const apiKey = input.apiKey || (input.keepApiKey !== false && sameEndpoint ? saved?.apiKey : undefined);
    return { provider: input.provider, ...(apiKey ? { apiKey } : {}), ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), ...(input.structuredOutput ? { structuredOutput: input.structuredOutput } : {}), models: Object.fromEntries(Object.entries(input.models).filter(([, value]) => value)) };
  };

  app.get('/dashboard/api/v1/admin/ai', (c) => {
    if (!owner(c)) return fail(c, 403, 'FORBIDDEN');
    const current = currentAi();
    return c.json({ data: {
      managedByEnvironment: aiFromEnv(deps.config),
      presets: PROVIDER_PRESETS.map(({ id, label, kind, baseUrl, needsApiKey, keyUrl, suggested, note }) => ({ id, label, kind, baseUrl: baseUrl ?? null, needsApiKey, keyUrl: keyUrl ?? null, suggested: suggested ?? {}, note: note ?? null })),
      current: current ? { provider: current.provider, baseUrl: current.baseUrl ?? null, structuredOutput: current.structuredOutput ?? null, models: current.models, hasApiKey: Boolean(current.apiKey) } : null,
    } }, 200, { 'Cache-Control': 'no-store' });
  });

  app.put('/dashboard/api/v1/admin/ai', async (c) => {
    if (!owner(c)) return fail(c, 403, 'FORBIDDEN');
    if (aiFromEnv(deps.config)) return fail(c, 409, 'AI_MANAGED_BY_ENVIRONMENT');
    try {
      const config = withKey(aiInput.parse(await c.req.json()));
      const preset = presetFor(config.provider);
      if (!preset) return fail(c, 422, 'UNKNOWN_PROVIDER');
      if (needsBaseUrl(config)) return fail(c, 422, 'BASE_URL_REQUIRED');
      if (!config.models.main) return fail(c, 422, 'MODEL_REQUIRED');
      deps.settings.set('ai', aiSettingsSchema.parse(config));
      return c.json({ data: { saved: true } });
    } catch (error) { if (error instanceof ZodError || error instanceof SyntaxError) return fail(c, 422, 'VALIDATION'); throw error; }
  });

  app.delete('/dashboard/api/v1/admin/ai', (c) => {
    if (!owner(c)) return fail(c, 403, 'FORBIDDEN');
    if (aiFromEnv(deps.config)) return fail(c, 409, 'AI_MANAGED_BY_ENVIRONMENT');
    deps.settings.delete('ai');
    return c.json({ data: { saved: true } });
  });

  // Lists the provider's models and, when a model is given, makes one tiny structured
  // request so people find out about a bad key or model before email starts flowing.
  app.post('/dashboard/api/v1/admin/ai/test', async (c) => {
    if (!owner(c)) return fail(c, 403, 'FORBIDDEN');
    let config: AiConfig;
    try { config = aiFromEnv(deps.config) ? currentAi()! : withKey(aiInput.parse(await c.req.json())); }
    catch { return fail(c, 422, 'VALIDATION'); }
    if (!config) return fail(c, 422, 'VALIDATION');
    if (needsBaseUrl(config)) return fail(c, 422, 'BASE_URL_REQUIRED');
    let provider;
    try { provider = createProvider(config, deps.fetch); } catch { return c.json({ data: { ok: false, error: 'AI_NOT_CONFIGURED', models: [] } }); }
    const signal = AbortSignal.timeout(45_000);
    const code = (error: unknown) => error instanceof Error && error.cause === UNREACHABLE ? 'AI_UNREACHABLE' : error instanceof Error && isLlmErrorCode(error.message) ? error.message : 'AI_PROVIDER_FAILED';
    let models: string[] = [];
    let listError: string | undefined;
    if (provider.listModels) { try { models = await provider.listModels(signal); } catch (error) { listError = code(error); } }
    if (!config.models.main) return c.json({ data: { ok: !listError, models, ...(listError ? { error: listError } : {}) } });
    try {
      const result = await provider.generate({ model: config.models.main, system: 'This is a connection test. Reply with ok set to true.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Connection test.' }] }], schema: pingSchema, schemaName: 'connection_test', maxOutputTokens: 200, signal });
      return c.json({ data: { ok: result.type === 'object', models, model: result.model, capabilities: provider.capabilities } });
    } catch (error) { return c.json({ data: { ok: false, models, error: code(error) } }); }
  });

  app.get('/dashboard/api/v1/admin/server', (c) => {
    if (!owner(c)) return fail(c, 403, 'FORBIDDEN');
    const google = deps.settings.get('google_oauth');
    return c.json({ data: {
      publicUrl: deps.config.APP_ORIGIN, publicUrlFromEnvironment: Boolean(deps.config.ORIGIN_FROM_ENV),
      google: { configured: Boolean(deps.config.GOOGLE_CLIENT_ID || google), fromEnvironment: Boolean(process.env.GOOGLE_CLIENT_ID), redirectUri: `${deps.config.APP_ORIGIN}/dashboard/google/callback` },
    } }, 200, { 'Cache-Control': 'no-store' });
  });

  app.put('/dashboard/api/v1/admin/server', async (c) => {
    if (!owner(c)) return fail(c, 403, 'FORBIDDEN');
    try {
      const input = z.object({ publicUrl: z.string().url().optional(), google: googleSettingsSchema.nullable().optional() }).strict().parse(await c.req.json());
      if (input.publicUrl) {
        if (deps.config.ORIGIN_FROM_ENV) return fail(c, 409, 'PUBLIC_URL_MANAGED_BY_ENVIRONMENT');
        const origin = new URL(input.publicUrl).origin;
        deps.settings.set('public_url', origin); deps.config.APP_ORIGIN = origin;
      }
      if (input.google === null) deps.settings.delete('google_oauth');
      else if (input.google) deps.settings.set('google_oauth', input.google);
      // Google credentials are read when the server starts.
      return c.json({ data: { saved: true, restartRequired: input.google !== undefined } });
    } catch (error) { if (error instanceof ZodError || error instanceof SyntaxError) return fail(c, 422, 'VALIDATION'); throw error; }
  });
}
