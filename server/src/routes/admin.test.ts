import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { resolveAiConfig, SettingsStore } from '../settings.js';

const SECRET = 'test-session-secret-change-me-1234567890';
const ORIGIN = 'https://fridgedoor.example.test';
async function signedIn(env: Record<string, string> = {}, llmFetch?: typeof fetch) {
  const db = new Database(':memory:'); migrate(db);
  const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: SECRET, PUBLIC_URL: ORIGIN, SETUP_TOKEN: 'setup-token-abcdefghijkl', ...env });
  const settings = new SettingsStore(db, SECRET);
  const app = createApp({ db, config, ...(llmFetch ? { llmFetch } : {}) });
  const setup = await app.request(`${ORIGIN}/dashboard/api/v1/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Host: 'fridgedoor.example.test' }, body: JSON.stringify({ token: 'setup-token-abcdefghijkl', householdName: 'Home', displayName: 'Alex', email: 'alex@example.test', password: 'long enough password', timezone: 'UTC' }) });
  const headers = { Cookie: setup.headers.get('set-cookie')!.split(';')[0]!, 'X-CSRF-Token': ((await setup.json()) as { data: { csrfToken: string } }).data.csrfToken, Origin: ORIGIN, 'Content-Type': 'application/json' };
  return { app, config, settings, headers };
}

describe('AI settings', () => {
  it('saves a provider, keeps the key secret and keeps it when the form leaves it blank', async () => {
    const { app, config, settings, headers } = await signedIn();
    const initial = await (await app.request('/dashboard/api/v1/admin/ai', { headers })).json() as { data: { current: unknown; presets: Array<{ id: string }> } };
    expect(initial.data.current).toBeNull();
    expect(initial.data.presets.map((preset) => preset.id)).toEqual(expect.arrayContaining(['openai', 'anthropic', 'gemini', 'openrouter', 'ollama', 'custom']));
    const save = (body: unknown) => app.request('/dashboard/api/v1/admin/ai', { method: 'PUT', headers, body: JSON.stringify(body) });
    expect((await save({ provider: 'anthropic', apiKey: 'sk-ant-secret', models: { main: 'claude-sonnet-5-5', email: 'claude-haiku-5-5' } })).status).toBe(200);
    expect((await save({ provider: 'anthropic', models: { main: 'claude-opus-5-5' } })).status).toBe(200);
    const shown = await (await app.request('/dashboard/api/v1/admin/ai', { headers })).json() as { data: { current: Record<string, unknown> } };
    expect(shown.data.current).toEqual({ provider: 'anthropic', baseUrl: null, structuredOutput: null, models: { main: 'claude-opus-5-5' }, hasApiKey: true });
    expect(JSON.stringify(shown)).not.toContain('sk-ant-secret');
    expect(resolveAiConfig(config, settings)).toMatchObject({ provider: 'anthropic', apiKey: 'sk-ant-secret' });
    expect((await save({ provider: 'not-a-provider', models: { main: 'x' } })).status).toBe(422);
    expect((await save({ provider: 'custom', models: { main: 'x' } })).status).toBe(422);
    expect((await save({ provider: 'azure-openai', models: { main: 'x' } })).status).toBe(422);
  });

  it('leaves AI settings from the environment alone', async () => {
    const { app, headers } = await signedIn({ AI_PROVIDER: 'ollama', AI_MODEL: 'llama' });
    const put = await app.request('/dashboard/api/v1/admin/ai', { method: 'PUT', headers, body: JSON.stringify({ provider: 'ollama', models: { main: 'x' } }) });
    expect(put.status).toBe(409);
    const removed = await app.request('/dashboard/api/v1/admin/ai', { method: 'DELETE', headers });
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ error: { code: 'AI_MANAGED_BY_ENVIRONMENT' } });
  });

  it('never sends the saved key to a different address', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchStub = (async (url: string, init: RequestInit) => { seen.push({ url, auth: new Headers(init.headers).get('authorization') }); return Response.json({ data: [] }); }) as unknown as typeof fetch;
    const { app, headers } = await signedIn({}, fetchStub);
    await app.request('/dashboard/api/v1/admin/ai', { method: 'PUT', headers, body: JSON.stringify({ provider: 'openrouter', apiKey: 'sk-or-secret', models: { main: 'some/model' } }) });
    await app.request('/dashboard/api/v1/admin/ai/test', { method: 'POST', headers, body: JSON.stringify({ provider: 'openrouter', baseUrl: 'https://attacker.example/v1', models: {} }) });
    expect(seen).toEqual([{ url: 'https://attacker.example/v1/models', auth: null }]);
  });

  it('is read-only when the environment configures AI', async () => {
    const { app, headers } = await signedIn({ AI_PROVIDER: 'openai', AI_API_KEY: 'sk-env', AI_MODEL: 'gpt-6-luna' });
    expect((await app.request('/dashboard/api/v1/admin/ai', { method: 'PUT', headers, body: JSON.stringify({ provider: 'anthropic', models: { main: 'x' } }) })).status).toBe(409);
    expect(await (await app.request('/dashboard/api/v1/admin/ai', { headers })).json()).toMatchObject({ data: { managedByEnvironment: true, current: { provider: 'openai', hasApiKey: true } } });
  });

  it('tests a connection by listing models and making one tiny request', async () => {
    const requests: string[] = [];
    const fetchStub = (async (url: string) => {
      requests.push(url);
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'llama3.3' }, { id: 'qwen3' }] });
      return Response.json({ model: 'llama3.3', choices: [{ message: { content: '{"ok":true}' } }] });
    }) as unknown as typeof fetch;
    const { app, headers } = await signedIn({}, fetchStub);
    const result = await app.request('/dashboard/api/v1/admin/ai/test', { method: 'POST', headers, body: JSON.stringify({ provider: 'ollama', models: { main: 'llama3.3' } }) });
    expect(await result.json()).toMatchObject({ data: { ok: true, models: ['llama3.3', 'qwen3'], model: 'llama3.3' } });
    expect(requests).toEqual(['http://host.docker.internal:11434/v1/models', 'http://host.docker.internal:11434/v1/chat/completions']);
  });

  it('reports that nothing answered when the AI server is down', async () => {
    const refused = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const { app, headers } = await signedIn({}, refused);
    const result = await app.request('/dashboard/api/v1/admin/ai/test', { method: 'POST', headers, body: JSON.stringify({ provider: 'ollama', models: { main: 'llama3.3' } }) });
    expect(await result.json()).toMatchObject({ data: { ok: false, error: 'AI_UNREACHABLE' } });
  });
});
