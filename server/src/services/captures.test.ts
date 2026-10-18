import Database from 'better-sqlite3';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { keyFromSecret } from '../crypto.js';
import { CaptureService } from './captures.js';

const now = new Date('2026-01-01T00:00:00.000Z');
function seed() { const db = new Database(':memory:'); migrate(db); db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString()); db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Alex', 'America/New_York', 1, now.toISOString()); db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m2', 'h1', 's2', 'Sam', 'America/New_York', 1, now.toISOString()); return db; }
const file = (bytes: Buffer, type: string) => ({ type, size: bytes.length, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } });

describe('captures', () => {
  it('rechecks authorization after reading media and before storing or dispatching it', async () => {
    const db = seed(); let saved = false; let allowed = true;
    const service = new CaptureService(db, keyFromSecret('capture-secret'), () => now, () => { saved = true; });
    await expect(service.create({ memberId: 'm1', householdId: 'h1' }, {
      clientCaptureId: 'revoked-during-upload',
      file: { type: 'application/pdf', async arrayBuffer() { allowed = false; return new TextEncoder().encode('%PDF-1.7\n/Type /Page\n').buffer; } },
    }, () => { if (!allowed) throw new Error('CAPTURE_CREDENTIAL_INVALID'); })).rejects.toThrow('CAPTURE_CREDENTIAL_INVALID');
    expect(db.prepare('SELECT count(*) AS n FROM captures').get()).toEqual({ n: 0 });
    expect(saved).toBe(false);
  });
  it('stores text once and keeps normalized image bytes owner-scoped and encrypted', async () => {
    const db = seed(); const service = new CaptureService(db, keyFromSecret('capture-secret'), () => now); const actor = { memberId: 'm1', householdId: 'h1' };
    const first = await service.create(actor, { clientCaptureId: '11111111-1111-4111-8111-111111111111', text: 'paper towels' });
    expect(await service.create(actor, { clientCaptureId: '11111111-1111-4111-8111-111111111111', text: 'paper towels' })).toEqual(first);
    await expect(service.create(actor, { clientCaptureId: '11111111-1111-4111-8111-111111111111', text: 'different' })).rejects.toThrow('CAPTURE_IDEMPOTENCY_CONFLICT');
    const jpeg = await sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const image = await service.create(actor, { clientCaptureId: '22222222-2222-4222-8222-222222222222', file: file(jpeg, 'image/jpeg') });
    const normalized = await sharp(service.readBlob(actor, image.captureId)).metadata();
    expect(normalized.format).toBe('png'); expect(normalized.width).toBe(1); expect(normalized.height).toBe(2); expect(normalized.orientation).toBeUndefined();
    expect(() => service.status({ memberId: 'm2', householdId: 'h1' }, image.captureId)).toThrow('NOT_FOUND');
  });
  it('rejects oversized, corrupt, and unsupported HEIC files', async () => {
    const db = seed(); const service = new CaptureService(db, keyFromSecret('capture-secret'), () => now); const actor = { memberId: 'm1', householdId: 'h1' };
    await expect(service.create(actor, { clientCaptureId: '33333333-3333-4333-8333-333333333333', file: { size: 10 * 1024 * 1024 + 1, async arrayBuffer() { return new ArrayBuffer(0); } } })).rejects.toThrow('CAPTURE_TOO_LARGE');
    await expect(service.create(actor, { clientCaptureId: '44444444-4444-4444-8444-444444444444', file: file(Buffer.from([1, 2, 3]), 'image/png') })).rejects.toThrow('UNSUPPORTED_OR_CORRUPT_FILE');
    const heic = Buffer.alloc(24); heic.writeUInt32BE(24, 0); heic.write('ftyp', 4); heic.write('heic', 8);
    await expect(service.create(actor, { clientCaptureId: '77777777-7777-4777-8777-777777777777', file: file(heic, 'image/heic') })).rejects.toThrow(/UNSUPPORTED_(HEIC_CONVERSION|OR_CORRUPT_FILE)/);
  });
  it('does not accept credentialed URL captures', async () => { const db = seed(); const service = new CaptureService(db, keyFromSecret('capture-secret'), () => now); await expect(service.create({ memberId: 'm1', householdId: 'h1' }, { clientCaptureId: '88888888-8888-4888-8888-888888888888', url: 'https://user:pass@example.test/item' })).rejects.toThrow('INVALID_CAPTURE_URL'); });
  it('rejects images above the pixel bound and PDFs whose page count is above ten', async () => {
    const db = seed(); const service = new CaptureService(db, keyFromSecret('capture-secret'), () => now); const actor = { memberId: 'm1', householdId: 'h1' };
    const large = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    await expect(service.create(actor, { clientCaptureId: '55555555-5555-4555-8555-555555555555', file: file(large, 'image/png') })).rejects.toThrow('CAPTURE_IMAGE_TOO_LARGE');
    const pdf = Buffer.from('%PDF-1.7\n' + Array.from({ length: 11 }, () => '/Type /Page\n').join(''));
    await expect(service.create(actor, { clientCaptureId: '66666666-6666-4666-8666-666666666666', file: file(pdf, 'application/pdf') })).rejects.toThrow('CAPTURE_TOO_MANY_PAGES');
  });
});
