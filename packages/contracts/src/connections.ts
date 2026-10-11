// Email connections (Google or IMAP with an app password) and the calendar subscription link.
export type EmailProvider = 'google' | 'imap';
export type EmailConnectionStatus = 'active' | 'paused' | 'needs_reauth' | 'disconnected';
/** GET /connection. `connected` is false (and most fields absent) when there is no connection. */
export type EmailConnection = {
  connected: boolean; status: EmailConnectionStatus | string; revision: number; generation?: number;
  /** Whether the server has Google sign-in configured (for Gmail and Google Calendar). */
  googleAvailable?: boolean;
  provider?: EmailProvider; email?: string; syncLastSuccessAt?: string | null; syncErrorCode?: string | null; analysisPending?: number;
};
export type ImapPreset = { id: string; label: string; host: string; port: number; secure: boolean; help: string | null; note: string };
export type ImapCredentials = { host: string; port: number; secure: boolean; username: string; password: string; mailbox: string };
export type ImapConnectInput = { email: string; credentials: ImapCredentials; disclosureVersion?: string };
export const IMAP_ERROR_CODES = ['IMAP_AUTH_FAILED', 'IMAP_UNREACHABLE', 'IMAP_TIMEOUT', 'IMAP_TLS_FAILED', 'IMAP_MAILBOX_NOT_FOUND', 'IMAP_FAILED'] as const;

export type CalendarFeedStatus = { active: boolean; createdAt: string | null; lastFetchedAt: string | null };
/** POST /calendar-feed: the only time the private link is shown. */
export type CreatedCalendarFeed = { active: true; url: string; webcalUrl: string };
