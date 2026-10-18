import { describe, expect, it } from 'vitest';
import { sharedDocumentExportUrl } from './shared-document.js';
const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz';
describe('shared document export urls', () => {
  it.each([
    [`https://docs.google.com/presentation/d/${id}/edit#slide=id.p1`, `https://docs.google.com/presentation/d/${id}/export?format=txt`],
    [`https://docs.google.com/document/d/${id}/edit`, `https://docs.google.com/document/d/${id}/export?format=txt`],
    [`https://docs.google.com/spreadsheets/d/${id}/edit?gid=7#gid=7`, `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=7`],
    [`https://docs.google.com.evil.example/presentation/d/${id}/edit`, null],
    [`http://docs.google.com/presentation/d/${id}/edit`, null],
  ])('maps %s', (link, expected) => expect(sharedDocumentExportUrl(link)).toBe(expected));
});
