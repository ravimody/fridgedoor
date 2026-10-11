import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AiAdminSettings } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
import { AiEditor } from './AiEditor.js';

vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const presets: AiAdminSettings['presets'] = [
  { id: 'openai', label: 'OpenAI (GPT)', kind: 'openai', baseUrl: null, needsApiKey: true, keyUrl: 'https://platform.openai.com/api-keys', suggested: { main: 'gpt-6-luna', email: 'gpt-6-luna' }, note: null },
  { id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: null, needsApiKey: true, keyUrl: 'https://console.anthropic.com/settings/keys', suggested: { main: 'claude-sonnet-5-5', email: 'claude-haiku-5-5' }, note: null },
  { id: 'ollama', label: 'Ollama (runs on your own computer)', kind: 'openai-compatible', baseUrl: 'http://host.docker.internal:11434/v1', needsApiKey: false, keyUrl: null, suggested: {}, note: 'Use a model with tool calling.' },
];
const saved: AiAdminSettings = { managedByEnvironment: false, presets, current: { provider: 'anthropic', baseUrl: null, structuredOutput: null, models: { main: 'claude-sonnet-5-5', transcribe: 'whisper-x' }, hasApiKey: true } };
const calls = (method: string, path: string) => vi.mocked(apiFetch).mock.calls.filter(([callPath, init]) => callPath === path && (init?.method ?? 'GET') === method);
const bodyOf = (method: string, path: string) => JSON.parse(String(calls(method, path).at(-1)![1]!.body)) as Record<string, unknown>;

function mockServer(settings: AiAdminSettings, test = { ok: true, models: ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'], model: 'claude-sonnet-5-5' }) {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/admin/ai' && !init?.method) return { data: settings };
    if (path === '/admin/ai/test') return { data: test };
    if (path === '/admin/ai' && init?.method === 'PUT') return { data: { saved: true } };
    throw new Error(`unexpected ${path}`);
  });
}

it('tests the connection and offers the provider’s models alongside the suggestions', async () => {
  mockServer(saved);
  const { container } = render(<AiEditor />);
  fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
  expect(await screen.findByText('Connected. claude-sonnet-5-5 answered the test.')).toBeVisible();
  expect(bodyOf('POST', '/admin/ai/test')).toEqual({ provider: 'anthropic', models: { main: 'claude-sonnet-5-5', transcribe: 'whisper-x' } });
  const options = [...container.querySelectorAll('datalist option')].map((option) => option.getAttribute('value'));
  expect(options).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
  expect(screen.getByLabelText('Model for the planner')).toHaveAttribute('list', container.querySelector('datalist')!.id);
});

it('keeps the saved key when the key field is left blank', async () => {
  mockServer(saved);
  const onSaved = vi.fn();
  render(<AiEditor onSaved={onSaved} />);
  const key = await screen.findByLabelText('API key');
  expect(key).toHaveValue('');
  expect(key).toHaveAttribute('placeholder', 'Saved. Leave blank to keep it.');
  fireEvent.change(screen.getByLabelText('Model for the planner'), { target: { value: 'claude-opus-5-5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save AI settings' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(bodyOf('PUT', '/admin/ai')).toEqual({ provider: 'anthropic', models: { main: 'claude-opus-5-5', transcribe: 'whisper-x' } });
  expect(screen.getByRole('status')).toHaveTextContent('Saved. The planner now uses Anthropic (Claude).');
});

it('asks for a key when switching to a provider without one, and sends a pasted key and email model', async () => {
  mockServer(saved);
  render(<AiEditor />);
  fireEvent.change(await screen.findByLabelText('AI provider'), { target: { value: 'openai' } });
  expect(screen.getByRole('link', { name: /Create one at OpenAI/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
  expect(screen.getByLabelText('API key')).not.toHaveAttribute('placeholder', 'Saved. Leave blank to keep it.');
  fireEvent.click(screen.getByRole('button', { name: 'Save AI settings' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Paste your API key first.');
  expect(calls('PUT', '/admin/ai')).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: ' sk-test ' } });
  fireEvent.click(screen.getByLabelText(/separate, cheaper model/));
  fireEvent.change(screen.getByLabelText('Model for emails'), { target: { value: 'gpt-6-mini' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save AI settings' }));
  await waitFor(() => expect(calls('PUT', '/admin/ai')).toHaveLength(1));
  expect(bodyOf('PUT', '/admin/ai')).toEqual({ provider: 'openai', apiKey: 'sk-test', models: { main: 'gpt-6-luna', email: 'gpt-6-mini' } });
});

it('shows a local server address instead of a key for self-hosted models', async () => {
  mockServer({ ...saved, current: null });
  render(<AiEditor />);
  fireEvent.change(await screen.findByLabelText('AI provider'), { target: { value: 'ollama' } });
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Server address')).toHaveAttribute('placeholder', 'http://host.docker.internal:11434/v1');
  expect(screen.getByText(/sent to the AI server at the address below/)).toBeVisible();
});

it('explains a failed test in plain language', async () => {
  mockServer(saved, { ok: false, models: [], error: 'AI_AUTH_FAILED' } as never);
  render(<AiEditor />);
  fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('didn’t accept this key');
});

it('is read-only when the server configuration sets AI', async () => {
  mockServer({ ...saved, managedByEnvironment: true });
  render(<AiEditor />);
  expect(await screen.findByText(/set in this server’s configuration/)).toBeVisible();
  expect(screen.getByText('Anthropic (Claude)')).toBeVisible();
  expect(screen.queryByLabelText('AI provider')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
});
