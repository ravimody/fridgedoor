-- Email can come from Gmail (OAuth) or any IMAP mailbox (an app password). Both kinds
-- live in google_connections so consent, generations, extraction and deletion work the
-- same way; `provider` says which. IMAP rows keep their server details and password in
-- encrypted_tokens and use `imap:<id>` as google_sub.
ALTER TABLE google_connections ADD COLUMN provider TEXT NOT NULL DEFAULT 'google' CHECK (provider IN ('google', 'imap'));
