import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { decryptText, encryptText, type Envelope } from '../crypto.js';
import { validateCaptureUrl } from './url-capture.js';

type Actor = { memberId: string; householdId: string };
type Clock = () => Date;
type CaptureMime = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/heic';

export type CaptureInput = {
  clientCaptureId: string;
  text?: string | undefined;
  url?: string | undefined;
  file?: { name?: string | undefined; type?: string | undefined; size?: number | undefined; arrayBuffer(): Promise<ArrayBuffer> } | undefined;
};

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_PDF_PAGES = 10;

function isHeic(bytes: Buffer) {
  if (bytes.length < 16 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
  const brands = [
    bytes.subarray(8, 12).toString('ascii'),
    ...Array.from({ length: Math.floor((bytes.length - 16) / 4) }, (_, index) => bytes.subarray(16 + index * 4, 20 + index * 4).toString('ascii')),
  ];
  return brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand));
}

export function sniffMime(bytes: Buffer): CaptureMime {
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.subarray(0, 2).equals(Buffer.from([255, 216]))) return 'image/jpeg';
  if (isHeic(bytes)) return 'image/heic';
  throw new Error('UNSUPPORTED_OR_CORRUPT_FILE');
}

async function normalizeImage(bytes: Buffer, mimeType: Exclude<CaptureMime, 'application/pdf'>) {
  if (mimeType === 'image/heic' && !sharp.format.heif?.input?.buffer) throw new Error('UNSUPPORTED_HEIC_CONVERSION');
  try {
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw new Error('CAPTURE_IMAGE_TOO_LARGE');
    const normalized = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' }).rotate().png({ compressionLevel: 9 }).toBuffer();
    if (normalized.length > MAX_BYTES) throw new Error('CAPTURE_TOO_LARGE');
    return normalized;
  } catch (error) {
    if (error instanceof Error && ['CAPTURE_IMAGE_TOO_LARGE', 'CAPTURE_TOO_LARGE', 'UNSUPPORTED_HEIC_CONVERSION'].includes(error.message)) throw error;
    throw new Error('UNSUPPORTED_OR_CORRUPT_FILE');
  }
}

function assertPdfBounds(bytes: Buffer) {
  const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page(?:\s|\/|>)/g) ?? []).length;
  if (!pages) throw new Error('PDF_PAGE_COUNT_UNAVAILABLE');
  if (pages > MAX_PDF_PAGES) throw new Error('CAPTURE_TOO_MANY_PAGES');
}

export class CaptureService {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly clock: Clock = () => new Date(), private readonly onSaved?: (actor: Actor, captureId: string) => void) {}

  async create(actor: Actor, input: CaptureInput, authorize?: () => void) {
    if (!input.clientCaptureId || input.clientCaptureId.length > 100) throw new Error('CLIENT_CAPTURE_ID_REQUIRED');
    const text = input.text?.trim();
    const url = input.url?.trim();
    if (!text && !url && !input.file) throw new Error('CAPTURE_INPUT_REQUIRED');
    let kind: 'text' | 'url' | 'file';
    let mimeType: string | null = null;
    let byteCount = 0;
    let encryptedBlob: string | null = null;
    let textValue: string | null = null;
    let body: Buffer;

    if (input.file) {
      if (input.file.size !== undefined && input.file.size > MAX_BYTES) throw new Error('CAPTURE_TOO_LARGE');
      const source = Buffer.from(await input.file.arrayBuffer());
      if (source.length > MAX_BYTES) throw new Error('CAPTURE_TOO_LARGE');
      const sourceMime = sniffMime(source);
      const declaredMime = input.file.type?.toLowerCase();
      if (declaredMime && !['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/heif'].includes(declaredMime)) throw new Error('UNSUPPORTED_OR_CORRUPT_FILE');
      if (declaredMime && declaredMime !== sourceMime && !(declaredMime === 'image/heif' && sourceMime === 'image/heic')) throw new Error('UNSUPPORTED_OR_CORRUPT_FILE');
      if (sourceMime === 'application/pdf') {
        assertPdfBounds(source);
        body = source;
        mimeType = sourceMime;
      } else {
        body = await normalizeImage(source, sourceMime);
        mimeType = 'image/png';
      }
      byteCount = body.length;
      encryptedBlob = JSON.stringify(encryptText(body.toString('base64'), this.key, `capture-blob:${input.clientCaptureId}`));
      kind = 'file';
    } else if (url) {
      const normalizedUrl = validateCaptureUrl(url);
      body = Buffer.from(normalizedUrl);
      kind = 'url';
      textValue = normalizedUrl;
    } else {
      if (!text || text.length > 8000) throw new Error('CAPTURE_TEXT_TOO_LONG');
      body = Buffer.from(text);
      kind = 'text';
      textValue = text;
    }

    const digest = createHash('sha256').update(body).digest('hex');
    return this.db.transaction(() => {
      authorize?.();
      const existing = this.db.prepare('SELECT id, body_digest as bodyDigest, state FROM captures WHERE owner_id = ? AND client_capture_id = ?').get(actor.memberId, input.clientCaptureId) as { id: string; bodyDigest: string; state: string } | undefined;
      if (existing) {
        if (existing.bodyDigest !== digest) throw new Error('CAPTURE_IDEMPOTENCY_CONFLICT');
        return { captureId: existing.id, status: existing.state };
      }
      const id = randomBytes(16).toString('hex');
      const now = this.clock().toISOString();
      this.db.prepare("INSERT INTO captures (id, owner_id, household_id, client_capture_id, body_digest, kind, mime_type, byte_count, encrypted_blob, text_value, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)").run(id, actor.memberId, actor.householdId, input.clientCaptureId, digest, kind, mimeType, byteCount, encryptedBlob, textValue, now, now);
      this.onSaved?.(actor, id);
      return { captureId: id, status: 'queued' as const };
    })();
  }

  status(actor: Actor, id: string) { const row = this.db.prepare('SELECT id, kind, mime_type as mimeType, byte_count as byteCount, state, created_at as createdAt FROM captures WHERE id = ? AND owner_id = ?').get(id, actor.memberId); if (!row) throw new Error('NOT_FOUND'); return row; }
  purgeOwner(memberId: string) { this.db.prepare('DELETE FROM captures WHERE owner_id = ?').run(memberId); }
  readBlob(actor: Actor, id: string) { const row = this.db.prepare('SELECT encrypted_blob as blob, client_capture_id as clientCaptureId FROM captures WHERE id = ? AND owner_id = ?').get(id, actor.memberId) as { blob: string | null; clientCaptureId: string } | undefined; if (!row?.blob) throw new Error('NOT_FOUND'); return Buffer.from(decryptText(JSON.parse(row.blob) as Envelope, this.key, `capture-blob:${row.clientCaptureId}`), 'base64'); }
}
