// Apply the same Inbox scope to ingestion and cached email AI inputs.
export function isInboxMessage(message: { labels?: string[]; labelIds?: string[] }) {
  const labels = message.labelIds ?? message.labels ?? [];
  return labels.includes('INBOX') && !labels.some(label => ['SPAM', 'TRASH', 'DRAFT'].includes(label));
}
