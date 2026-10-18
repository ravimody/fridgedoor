import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { dataSecret, loadConfig } from './config.js';

const dirs: string[] = [];
const dir = () => { const value = mkdtempSync(join(tmpdir(), 'fridgedoor-config-')); dirs.push(value); return value; };
afterEach(() => { for (const value of dirs.splice(0)) rmSync(value, { recursive: true, force: true }); });

it('creates the secret once, privately, and reads it back', () => {
  const data = dir();
  const secret = dataSecret(data);
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  expect(dataSecret(data)).toBe(secret);
  expect(statSync(join(data, 'secret.key')).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(data, 'secret.key'), 'utf8')).toBe(`${secret}\n`);
});

it('uses the secret another process already wrote', () => {
  const data = dir(); writeFileSync(join(data, 'secret.key'), `${'b'.repeat(64)}\n`);
  expect(dataSecret(data)).toBe('b'.repeat(64));
});

it('refuses an empty or truncated secret instead of encrypting with it', () => {
  const data = dir(); writeFileSync(join(data, 'secret.key'), '\n');
  expect(() => dataSecret(data)).toThrow(/empty or too short/);
});

it('accepts a client address header only as a header name', () => {
  expect(loadConfig({ NODE_ENV: 'test', CLIENT_IP_HEADER: 'Fly-Client-IP' }).CLIENT_IP_HEADER).toBe('Fly-Client-IP');
  expect(() => loadConfig({ NODE_ENV: 'test', CLIENT_IP_HEADER: 'X: y' })).toThrow();
});
