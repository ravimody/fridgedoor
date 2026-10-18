import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

export type Envelope = { version: 1; iv: string; ciphertext: string; tag: string };
export function keyFromSecret(secret: string) { return createHash('sha256').update(secret).digest(); }
export function encryptText(value: string, key: Buffer, aad: string): Envelope { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(aad)); const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return { version: 1, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }; }
export function decryptText(envelope: Envelope, key: Buffer, aad: string) { const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url')); decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url')); return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8'); }
export function encryptJson<T>(value: T, key: Buffer, aad: string) { return encryptText(JSON.stringify(value), key, aad); }
export function decryptJson<T>(envelope: Envelope, key: Buffer, aad: string) { return JSON.parse(decryptText(envelope, key, aad)) as T; }
export function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function indexKey(value: string, key: Buffer) { return createHmac('sha256', key).update(value).digest('hex'); }
