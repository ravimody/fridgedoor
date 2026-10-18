import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt from Node's standard library: no native add-on to build on small ARM hosts.
// N = 2^17, r = 8 (OWASP's scrypt baseline) needs 128 MiB per check; the test suite uses a
// cheaper cost so it stays fast. Older, cheaper hashes still verify and are upgraded at sign-in.
export const SCRYPT_N = process.env.VITEST ? 2 ** 14 : 2 ** 17;
const R = 8, P = 1, KEYLEN = 64;
const MAX_N = 2 ** 17;
// At most two checks at once, so a burst of sign-ins can't take 128 MiB each on a 512 MB host.
let running = 0; const waiting: Array<() => void> = [];
const slot = async () => { if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve)); running++; };
const release = () => { running--; waiting.shift()?.(); };
const derive = async (password: string, salt: Buffer, n = SCRYPT_N, r = R, p = P) => {
  if (!Number.isInteger(n) || n < 2 || n > MAX_N || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) throw new Error('PASSWORD_HASH_INVALID');
  await slot();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 256 * n * r * p }, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally { release(); }
};

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export async function hashPassword(password: string, n = SCRYPT_N): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, n);
  return ['scrypt', n, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** True for hashes made with a lower cost than new ones get. */
export function needsRehash(stored: string) { const [scheme, n] = stored.split('$'); return scheme !== 'scrypt' || Number(n) < SCRYPT_N; }

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  let actual: Buffer;
  try { actual = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p)); } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Spends the same time as a real check so unknown emails can't be told apart by timing. */
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(password: string) { dummy ??= hashPassword('fridgedoor-timing-equalizer'); await verifyPassword(password, await dummy); }
