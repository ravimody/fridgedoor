import sharp from 'sharp';
import type { GmailPart } from '../providers/google.js';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 5;
export const MAX_ATTACHMENT_PIXELS = 20_000_000;
export const MAX_ATTACHMENT_PAGES = 10;

export type SourceMedia = {
  kind: 'image' | 'pdf';
  mimeType: 'image/png' | 'application/pdf';
  dataBase64: string;
  pageCount?: number;
  width?: number;
  height?: number;
};

export type GmailAttachmentRef = {
  mimeType: string;
  filename?: string;
  attachmentId?: string;
  inlineData?: string;
  size?: number;
};

export function supportedAttachment(mimeType: string | undefined) {
  return ['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/heif'].includes(mimeType?.toLowerCase() ?? '');
}

function isHeic(bytes: Buffer) {
  if (bytes.length < 16 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
  const brands = [
    bytes.subarray(8, 12).toString('ascii'),
    ...Array.from({ length: Math.floor((bytes.length - 16) / 4) }, (_, index) => bytes.subarray(16 + index * 4, 20 + index * 4).toString('ascii')),
  ];
  return brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand));
}

function sniffMime(bytes: Buffer) {
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf' as const;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png' as const;
  if (bytes.subarray(0, 2).equals(Buffer.from([255, 216]))) return 'image/jpeg' as const;
  if (isHeic(bytes)) return 'image/heic' as const;
  throw new Error('ATTACHMENT_CORRUPT');
}

function decodeBase64(value: string) {
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
}

function assertPdfBounds(bytes: Buffer) {
  const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page(?:\s|\/|>)/g) ?? []).length;
  if (!pages) throw new Error('ATTACHMENT_PDF_PAGE_COUNT_UNAVAILABLE');
  if (pages > MAX_ATTACHMENT_PAGES) throw new Error('ATTACHMENT_TOO_MANY_PAGES');
  return pages;
}

export function collectAttachmentRefs(part: GmailPart | undefined, refs: GmailAttachmentRef[], unsupported: { value: boolean }) {
  if (!part) return;
  if (part.filename) {
    const mimeType = part.mimeType?.toLowerCase() ?? '';
    if (!supportedAttachment(mimeType)) unsupported.value = true;
    else refs.push({ mimeType, ...(part.filename ? { filename: part.filename } : {}), ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}), ...(part.body?.data ? { inlineData: part.body.data } : {}), ...(part.body?.size === undefined ? {} : { size: part.body.size }) });
  }
  for (const child of part.parts ?? []) collectAttachmentRefs(child, refs, unsupported);
}

export async function normalizeAttachment(bytes: Buffer, declaredMime: string): Promise<SourceMedia> {
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
  const sniffed = sniffMime(bytes);
  const declared = declaredMime.toLowerCase();
  if (!([sniffed, sniffed === 'image/heic' ? 'image/heif' : ''].includes(declared))) throw new Error('ATTACHMENT_MIME_MISMATCH');
  if (sniffed === 'application/pdf') return { kind: 'pdf', mimeType: 'application/pdf', dataBase64: bytes.toString('base64'), pageCount: assertPdfBounds(bytes) };
  if (sniffed === 'image/heic' && !sharp.format.heif?.input?.buffer) throw new Error('ATTACHMENT_HEIC_UNSUPPORTED');
  try {
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height || width * height > MAX_ATTACHMENT_PIXELS) throw new Error('ATTACHMENT_IMAGE_TOO_LARGE');
    const normalized = await sharp(bytes, { limitInputPixels: MAX_ATTACHMENT_PIXELS, failOn: 'error' }).rotate().png({ compressionLevel: 9 }).toBuffer();
    if (normalized.length > MAX_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
    const normalizedMetadata = await sharp(normalized).metadata();
    return { kind: 'image', mimeType: 'image/png', dataBase64: normalized.toString('base64'), width: normalizedMetadata.width, height: normalizedMetadata.height };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('ATTACHMENT_')) throw error;
    throw new Error('ATTACHMENT_CORRUPT');
  }
}

export async function normalizeGmailAttachment(input: { declaredMime: string; inlineData?: string | undefined; fetchedData?: string | undefined }): Promise<SourceMedia> {
  const data = input.inlineData ?? input.fetchedData;
  if (!data) throw new Error('ATTACHMENT_DATA_MISSING');
  return normalizeAttachment(decodeBase64(data), input.declaredMime);
}
