import { describe, expect, it } from 'vitest';
import { identityFromPayload } from './access.js';

describe('Access identity validation', () => { it('requires a stable subject', () => { expect(identityFromPayload({ sub: 'member-sub' })).toEqual({ subject: 'member-sub' }); expect(identityFromPayload({})).toBeNull(); }); });
