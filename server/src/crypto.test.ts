import { describe, expect, it } from 'vitest';
import { decryptJson, encryptJson, keyFromSecret } from './crypto.js';

describe('encrypted application values', () => { it('fails closed when ciphertext is tampered', () => { const key = keyFromSecret('test-key'); const envelope = encryptJson({ token: 'private' }, key, 'row:1'); envelope.ciphertext = `${envelope.ciphertext}x`; expect(() => decryptJson(envelope, key, 'row:1')).toThrow(); }); it('binds ciphertext to its context', () => { const key = keyFromSecret('test-key'); const envelope = encryptJson({ token: 'private' }, key, 'row:1'); expect(() => decryptJson(envelope, key, 'row:2')).toThrow(); }); });
