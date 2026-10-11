import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt from Node's standard library: no native add-on to build on small ARM hosts.
const N = 16384, R = 8, P = 1, KEYLEN = 64;
const derive = (password: string, salt: Buffer, n = N, r = R, p = P) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Spends the same time as a real check so unknown emails can't be told apart by timing. */
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(password: string) { dummy ??= hashPassword('fridgedoor-timing-equalizer'); await verifyPassword(password, await dummy); }
