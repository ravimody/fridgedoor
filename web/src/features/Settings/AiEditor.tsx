import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AiAdminSettings, AiCurrentSettings, AiModels, AiProviderPreset, AiSettingsInput, AiTestResult } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
import { errorMessage, FormError } from '../Auth/forms.js';

type Form = { provider: string; apiKey: string; baseUrl: string; main: string; email: string; separateEmail: boolean };

const fromPreset = (preset: AiProviderPreset): Form => ({ provider: preset.id, apiKey: '', baseUrl: '', main: preset.suggested.main ?? '', email: preset.suggested.email ?? '', separateEmail: Boolean(preset.suggested.email && preset.suggested.email !== preset.suggested.main) });
const fromCurrent = (current: AiCurrentSettings): Form => ({ provider: current.provider, apiKey: '', baseUrl: current.baseUrl ?? '', main: current.models.main ?? '', email: current.models.email ?? '', separateEmail: Boolean(current.models.email && current.models.email !== current.models.main) });
const initialForm = (settings: AiAdminSettings): Form | undefined => settings.current ? fromCurrent(settings.current) : settings.presets[0] && fromPreset(settings.presets[0]);
/** Hosted providers with a fixed address don't need the field; local servers, Azure and custom APIs do. */
const showsBaseUrl = (preset: AiProviderPreset) => !preset.needsApiKey || (!preset.baseUrl && preset.id !== 'openai' && preset.id !== 'anthropic');
const showsApiKey = (preset: AiProviderPreset) => preset.needsApiKey || !preset.baseUrl;

const testMessages: Record<string, string> = {
  AI_AUTH_FAILED: 'The provider didn’t accept this key. Check that you copied all of it.',
  AI_MODEL_NOT_FOUND: 'The provider doesn’t have a model with that name. Pick one from the list.',
  AI_RATE_LIMITED: 'The provider says you’ve reached a limit. Check your account’s billing, or wait a minute.',
  AI_RETRYABLE: 'The provider is busy or slow to answer. Try again in a minute.',
  AI_NOT_CONFIGURED: 'Fill in the details above first.',
};
const saveMessages: Record<string, string> = {
  AI_MANAGED_BY_ENVIRONMENT: 'AI is set in the server’s configuration, so it can’t be changed here.',
  MODEL_REQUIRED: 'Choose a model for the planner.',
  UNKNOWN_PROVIDER: 'Choose an AI provider from the list.',
  BASE_URL_REQUIRED: 'This provider needs the address of its server, such as http://192.168.1.20:8080/v1.',
  VALIDATION: 'Check the server address. It should start with http:// or https://.',
};

/**
 * Chooses the AI provider, key and models the planner uses. Shared by the setup wizard and Settings.
 * Leaving the key blank keeps the saved key when the provider doesn't change.
 */
export function AiEditor({ autoFocus = false, onSaved, saveLabel = 'Save AI settings', allowRemove = false }: { autoFocus?: boolean; onSaved?: () => void; saveLabel?: string; allowRemove?: boolean }) {
  const id = useId();
  const [settings, setSettings] = useState<AiAdminSettings>();
  const [form, setForm] = useState<Form>();
  const [loadError, setLoadError] = useState('');
  const [test, setTest] = useState<AiTestResult>();
  const [busy, setBusy] = useState<'test' | 'save' | 'remove'>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** Set after a save was held back because the last test failed; the next save goes through. */
  const [saveAnyway, setSaveAnyway] = useState(false);
  const providerField = useRef<HTMLSelectElement>(null);

  async function load() {
    const response = await apiFetch<{ data: AiAdminSettings }>('/admin/ai');
    setSettings(response.data); setForm(initialForm(response.data));
  }
  useEffect(() => {
    apiFetch<{ data: AiAdminSettings }>('/admin/ai').then((response) => { setSettings(response.data); setForm(initialForm(response.data)); }, () => setLoadError('Could not load the AI settings. Reload to try again.'));
  }, []);
  const ready = Boolean(form);
  useEffect(() => { if (autoFocus && ready) providerField.current?.focus(); }, [autoFocus, ready]);

  if (loadError) return <p role="alert" className="form-error">{loadError}</p>;
  if (!settings || !form) return <p role="status" className="muted">Loading AI settings…</p>;
  const current = settings.current;
  const preset = settings.presets.find((candidate) => candidate.id === form.provider);
  const sameProvider = current?.provider === form.provider;
  const keySaved = Boolean(sameProvider && current?.hasApiKey);

  function body(includeMain = true): AiSettingsInput {
    const models: AiModels = {
      ...(includeMain && form!.main.trim() ? { main: form!.main.trim() } : {}),
      ...(form!.separateEmail && form!.email.trim() ? { email: form!.email.trim() } : {}),
      // Models this form doesn't show (review, transcription) stay as they were.
      ...(sameProvider && current?.models.review ? { review: current.models.review } : {}),
      ...(sameProvider && current?.models.transcribe ? { transcribe: current.models.transcribe } : {}),
    };
    return {
      provider: form!.provider,
      ...(form!.apiKey.trim() ? { apiKey: form!.apiKey.trim() } : {}),
      ...(form!.baseUrl.trim() ? { baseUrl: form!.baseUrl.trim() } : {}),
      ...(sameProvider && current?.structuredOutput ? { structuredOutput: current.structuredOutput } : {}),
      models,
    };
  }
  const missingKey = () => Boolean(preset?.needsApiKey && !form.apiKey.trim() && !keySaved);

  function chooseProvider(providerId: string) {
    const next = settings!.presets.find((candidate) => candidate.id === providerId);
    if (!next) return;
    setForm(current?.provider === providerId ? fromCurrent(current) : fromPreset(next));
    setTest(undefined); setError(''); setNotice('');
  }

  async function runTest() {
    if (missingKey()) { setError('Paste your API key first.'); return; }
    setBusy('test'); setError(''); setNotice(''); setTest(undefined); setSaveAnyway(false);
    try { setTest((await apiFetch<{ data: AiTestResult }>('/admin/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings!.managedByEnvironment ? { provider: form!.provider, models: {} } : body()) })).data); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(undefined); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (missingKey()) { setError('Paste your API key first.'); return; }
    if (!form!.main.trim()) { setError('Choose a model for the planner. Test the connection to see the list.'); return; }
    if (form!.separateEmail && !form!.email.trim()) { setError('Choose a model for emails, or untick “Use a separate, cheaper model for reading emails”.'); return; }
    if (test && !test.ok && !saveAnyway) { setError('The last connection test didn’t work, so the planner may not answer. Fix it and test again, or save anyway.'); setSaveAnyway(true); return; }
    setBusy('save'); setError(''); setNotice('');
    try {
      await apiFetch('/admin/ai', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
      setNotice(`Saved. The planner now uses ${preset?.label ?? form!.provider}.`); setSaveAnyway(false);
      await load().catch(() => undefined);
      onSaved?.();
    } catch (caught) { setError(errorMessage(caught, saveMessages)); }
    finally { setBusy(undefined); }
  }

  async function remove() {
    if (!window.confirm('Turn off AI? The planner won’t read emails or answer questions until you set it up again.')) return;
    setBusy('remove'); setError(''); setNotice('');
    try {
      await apiFetch('/admin/ai', { method: 'DELETE' });
      await load();
      setTest(undefined); setNotice('AI is turned off.');
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(undefined); }
  }

  const address = form.baseUrl.trim() || preset?.baseUrl;
  // Local servers are usually just not running; a typed address may be wrong; a cloud provider means the server is offline.
  const unreachable = preset && !preset.needsApiKey && preset.baseUrl && address
    ? `Nothing answered at ${address}. Check that ${shortLabel(preset.label)} is running and that the Fridgedoor server can reach that computer.`
    : form.baseUrl.trim() || (preset && showsBaseUrl(preset) && !preset.baseUrl)
      ? `Nothing answered at ${address ?? 'that address'}. Check the address, and that the AI server is running.`
      : `Your Fridgedoor server couldn’t reach ${shortLabel(preset?.label ?? 'the provider')}. Check that the server is online, then try again.`;
  const testResult = test && (test.ok
    ? <p role="status" className="notice">{test.model ? `Connected. ${test.model} answered the test.` : `Connected. Found ${test.models.length} ${test.models.length === 1 ? 'model' : 'models'}; choose one below.`}</p>
    : <p role="alert" className="form-error">{test.error === 'AI_UNREACHABLE' ? unreachable : testMessages[test.error ?? ''] ?? 'The test didn’t work. Check the key, address and model, then try again.'}</p>);

  if (settings.managedByEnvironment) {
    const label = settings.presets.find((candidate) => candidate.id === current?.provider)?.label ?? current?.provider;
    return <div className="ai-editor">
      <p>AI is set in this server’s configuration, so it can’t be changed here. To change it, edit the server’s settings file and restart Fridgedoor.</p>
      {current && <dl className="ai-summary"><dt>Provider</dt><dd>{label}</dd><dt>Model</dt><dd>{current.models.main ?? 'Not set'}</dd>{current.models.email && <><dt>Email model</dt><dd>{current.models.email}</dd></>}</dl>}
      <div className="button-row"><button className="secondary" disabled={Boolean(busy)} onClick={() => void runTest()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button></div>
      {testResult}<FormError message={error} />
    </div>;
  }

  const modelOptions = [...new Set([...(test?.models ?? []), preset?.suggested.main, preset?.suggested.email, current && sameProvider ? current.models.main : undefined].filter((value): value is string => Boolean(value)))];
  // A failed test no longer describes the form once it changes: drop it, and the save hold with it.
  const set = (field: 'apiKey' | 'baseUrl' | 'main' | 'email') => (event: { target: { value: string } }) => {
    setForm({ ...form, [field]: event.target.value });
    if (test && !test.ok) { setTest(undefined); setSaveAnyway(false); setError(''); }
  };
  return <form className="ai-editor" onSubmit={(event) => void save(event)} noValidate>
    <p>The planner uses an AI service to read the emails, messages, photos and PDFs you send it, and to turn them into plans and answers. {preset && !preset.needsApiKey
      ? 'They’re sent to the AI server at the address below, which can be a computer you run yourself.'
      : <>They’re sent to <strong>{preset?.label ?? 'the provider you choose'}</strong> to be processed, under that company’s privacy terms.</>} Nothing is sent until you save.</p>
    <label>AI provider<select ref={providerField} value={form.provider} onChange={(event) => chooseProvider(event.target.value)}>{settings.presets.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
    {preset?.keyUrl && <p className="field-hint">Don’t have a key yet? <a href={preset.keyUrl} target="_blank" rel="noreferrer">Create one at {preset.label}</a>, copy it, and paste it below. Providers usually charge a little per use.</p>}
    {preset?.note && <p className="field-hint">{preset.note}</p>}
    {preset && showsApiKey(preset) && <label>{preset.needsApiKey ? 'API key' : 'API key (if your server needs one)'}<input type="password" autoComplete="off" spellCheck={false} value={form.apiKey} onChange={set('apiKey')} placeholder={keySaved ? 'Saved. Leave blank to keep it.' : ''} /></label>}
    {preset && showsBaseUrl(preset) && <label>Server address<input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={form.baseUrl} onChange={set('baseUrl')} placeholder={preset.baseUrl ?? 'https://example.com/v1'} /></label>}
    {preset && showsBaseUrl(preset) && preset.baseUrl && <p className="field-hint">{sameComputerHint(preset.label, preset.baseUrl)}</p>}
    <div className="button-row"><button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void runTest()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button></div>
    {testResult}
    <label>Model for the planner<input list={`${id}-models`} autoComplete="off" spellCheck={false} value={form.main} onChange={set('main')} aria-describedby={`${id}-main-hint`} /></label>
    <p id={`${id}-main-hint`} className="field-hint">Used for chat and planning. Pick from the list or type a model name.</p>
    <label className="checkbox"><input type="checkbox" checked={form.separateEmail} onChange={(event) => setForm({ ...form, separateEmail: event.target.checked })} /> Use a separate, cheaper model for reading emails</label>
    {form.separateEmail && <label>Model for emails<input list={`${id}-models`} autoComplete="off" spellCheck={false} value={form.email} onChange={set('email')} /></label>}
    <datalist id={`${id}-models`}>{modelOptions.map((model) => <option key={model} value={model} />)}</datalist>
    <FormError message={error} />
    {notice && <p role="status" className="notice">{notice}</p>}
    <div className="button-row">
      <button type="submit" disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : saveAnyway ? 'Save anyway' : saveLabel}</button>
      {allowRemove && current && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void remove()}>Turn off AI</button>}
    </div>
  </form>;
}

/** `host.docker.internal` is Docker's name for the computer running the container; say that instead. */
function sameComputerHint(label: string, baseUrl: string) {
  if (!baseUrl.includes('host.docker.internal')) return `Leave blank to use ${baseUrl}.`;
  const port = new URL(baseUrl).port;
  return `Leave blank if ${shortLabel(label)} runs on the same computer as Fridgedoor. If it runs on another computer, enter that computer’s address, such as http://192.168.1.20${port ? `:${port}` : ''}/v1.`;
}

/** "Ollama (runs on your own computer)" → "Ollama". */
const shortLabel = (label: string) => label.replace(/ \(.*\)$/, '');
