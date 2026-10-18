// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

/** Loads public/sw.js with a fake worker scope and returns its fetch handler's response, if it answered. */
function fetchHandler(fetchImpl: () => Promise<Response>) {
  const handlers = new Map<string, (event: unknown) => void>();
  const offline = new Response('offline page');
  const caches = { match: vi.fn(async (request: unknown) => (request === '/pwa/offline.html' ? offline : undefined)) };
  runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), {
    self: { addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler), location: { origin: 'https://fridgedoor.example.test' } },
    caches, fetch: fetchImpl, URL, Response,
  });
  return async (url: string, mode: string, method = 'GET') => {
    let response: Promise<Response> | undefined;
    handlers.get('fetch')!({ request: { url, mode, method }, respondWith: (value: Promise<Response>) => { response = value; } });
    return { response: response && await response, offline };
  };
}

it('shows the offline page when opening the app fails for lack of a connection', async () => {
  const handle = fetchHandler(() => Promise.reject(new TypeError('Failed to fetch')));
  const { response, offline } = await handle('https://fridgedoor.example.test/dashboard/todos', 'navigate');
  expect(response).toBe(offline);
});

it('passes online navigations through and leaves API requests alone', async () => {
  const page = new Response('app shell');
  const handle = fetchHandler(() => Promise.resolve(page));
  expect((await handle('https://fridgedoor.example.test/dashboard/', 'navigate')).response).toBe(page);
  expect((await handle('https://fridgedoor.example.test/dashboard/api/v1/plans', 'cors')).response).toBeUndefined();
  expect((await handle('https://fridgedoor.example.test/dashboard/api/v1/plans', 'navigate', 'POST')).response).toBeUndefined();
});
