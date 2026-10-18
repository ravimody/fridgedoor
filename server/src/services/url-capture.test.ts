import { describe, expect, it } from 'vitest';
import { validateCaptureUrl } from './url-capture.js';
describe('url capture', () => { it('allows ordinary URLs and rejects credentialed or non-http URLs', () => { expect(validateCaptureUrl('https://example.com/item')).toBe('https://example.com/item'); expect(() => validateCaptureUrl('file:///etc/passwd')).toThrow('INVALID_CAPTURE_URL'); expect(() => validateCaptureUrl('https://user:pass@example.com')).toThrow('INVALID_CAPTURE_URL'); }); });
