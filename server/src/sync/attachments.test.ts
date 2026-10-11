import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { normalizeAttachment, normalizeGmailAttachment } from './attachments.js';

const pdf = (pages: number) => Buffer.from(`%PDF-1.7\n${Array.from({ length: pages }, (_, index) => `${index} 0 obj /Type /Page >> endobj`).join('\n')}\n%%EOF`);

describe('Gmail attachment bounds', () => {
  it('normalizes an image and preserves a bounded media descriptor', async () => {
    const input = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const result = await normalizeAttachment(input, 'image/jpeg');
    expect(result).toMatchObject({ kind: 'image', mimeType: 'image/png', width: 2, height: 3 });
    expect(Buffer.from(result.dataBase64, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('accepts a small PDF and rejects corrupt or over-page documents', async () => {
    await expect(normalizeAttachment(pdf(2), 'application/pdf')).resolves.toMatchObject({ kind: 'pdf', pageCount: 2 });
    await expect(normalizeAttachment(pdf(11), 'application/pdf')).rejects.toThrow('ATTACHMENT_TOO_MANY_PAGES');
    await expect(normalizeAttachment(Buffer.from('not a document'), 'application/pdf')).rejects.toThrow('ATTACHMENT_CORRUPT');
  });

  it('decodes Gmail base64url attachment data without accepting MIME spoofing', async () => {
    const input = pdf(1).toString('base64url');
    await expect(normalizeGmailAttachment({ declaredMime: 'application/pdf', fetchedData: input })).resolves.toMatchObject({ kind: 'pdf', pageCount: 1 });
    await expect(normalizeGmailAttachment({ declaredMime: 'image/png', fetchedData: input })).rejects.toThrow('ATTACHMENT_MIME_MISMATCH');
  });
});
