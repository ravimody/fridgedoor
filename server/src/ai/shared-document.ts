// Reads Google Sheets/Docs/Slides links shared as "anyone with the link" through their
// plain-text export. Only docs.google.com is requested, so model-supplied URLs
// cannot reach other hosts; private documents return an error, not a login page.
const MAX_CHARS = 40_000;
export type SharedDocument = { text: string; truncated: boolean; source: string } | { error: 'UNSUPPORTED_LINK' | 'DOCUMENT_NOT_PUBLIC' | 'DOCUMENT_UNAVAILABLE' };

export function sharedDocumentExportUrl(link: string): string | null {
  let url: URL; try { url = new URL(link); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return null;
  const match = /^\/(spreadsheets|document|presentation)\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/.exec(url.pathname);
  if (!match) return null;
  const [, kind, id] = match;
  if (kind === 'document' || kind === 'presentation') return `https://docs.google.com/${kind}/d/${id}/export?format=txt`;
  // The tab id usually lives in the fragment (#gid=…); fall back to the query string.
  const gid = /(?:^|[#&])gid=(\d+)/.exec(url.hash)?.[1] ?? url.searchParams.get('gid');
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}

export async function readSharedDocument(link: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<SharedDocument> {
  const exportUrl = sharedDocumentExportUrl(link);
  if (!exportUrl) return { error: 'UNSUPPORTED_LINK' };
  try {
    const response = await fetchImpl(exportUrl, { redirect: 'follow', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    // Private documents redirect to a Google sign-in HTML page instead of an export.
    if (!response.ok || (response.headers.get('content-type') ?? '').includes('text/html')) return { error: response.ok || response.status === 401 || response.status === 403 ? 'DOCUMENT_NOT_PUBLIC' : 'DOCUMENT_UNAVAILABLE' };
    // Stop reading once past the cap so a very large sheet cannot exhaust memory.
    const reader = response.body?.getReader(); const decoder = new TextDecoder(); let text = '';
    while (reader && text.length <= MAX_CHARS) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
    await reader?.cancel();
    return { text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS, source: link };
  } catch (error) {
    if (signal.aborted) throw error;
    return { error: 'DOCUMENT_UNAVAILABLE' };
  }
}
