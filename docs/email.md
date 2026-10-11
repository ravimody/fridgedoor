# Connecting email

Each person connects their own mailbox in **Settings → Email**. Fridgedoor checks it
every few minutes, reads new messages in the inbox (never sent mail, drafts or spam),
and turns the ones worth remembering into suggestions. It never sends, deletes or marks
anything as read.

The email itself stays private to the person who connected it. What the household
sees is a plan: clear, everyday logistics (a school event, a practice time) become a
shared suggestion automatically, while anything uncertain, personal, medical or
work-related stays private to you until you choose to share it. You can exclude
senders, and pause or disconnect at any time; disconnecting stops reading immediately.

## The easy way: an app password (IMAP)

An app password is a separate password that only lets an app read mail, and you can
revoke it without changing your real password. Create one, then choose your provider in
Settings → Email, enter your address and the app password, and press **Connect**.

| Provider | How to get an app password |
| --- | --- |
| **Gmail** | Turn on 2-Step Verification, then visit [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). Google Workspace admins may have to allow this. |
| **iCloud Mail** | [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords. |
| **Fastmail** | Settings → Privacy & Security → Integrations → New app password (IMAP). |
| **Yahoo / AOL** | Account Security → Generate app password. |
| **Zoho** | Enable IMAP access; create an app-specific password if two-factor sign-in is on. |
| **Anything else** | Your provider's IMAP server (usually `imap.<domain>`, port 993) and an app password if it offers them. |

Proton Mail isn't supported yet: its Bridge uses a certificate Fridgedoor won't accept.
Outlook.com and Microsoft 365 no longer accept passwords for IMAP. Forward the emails
you care about (school, activities) to another mailbox, or use Gmail forwarding rules.

If the password stops working (you revoked it, or changed your account password), the
connection pauses with a message in Settings until you enter a new one.

## The advanced way: Gmail and Google Calendar with Google sign-in

Google sign-in also lets Fridgedoor read your Google calendars and add events to a
shared family calendar. It needs a Google Cloud project that the server owner creates
once for the household:

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and
   enable the **Gmail API** and **Google Calendar API**.
2. Configure the OAuth consent screen as **External**, add yourself and your partner
   as test users, and add the scopes `openid`, `email`, `gmail.readonly`,
   `calendar.calendarlist.readonly` and `calendar.events`.
3. Create an **OAuth client ID** of type *Web application* with the redirect URI shown in
   Fridgedoor under Settings → Server (`https://<your address>/dashboard/google/callback`).
4. Paste the client ID and secret into Settings → Server (or set `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`) and restart the server.
5. Each person can now choose **Connect with Google** in Settings → Email.

While the consent screen is in *Testing*, Google expires the sign-in after 7 days, so
you'd reconnect weekly. Publishing the app to *In production* without verification
avoids that for a handful of users you add yourself; Google shows an "unverified app"
warning you can click through. Gmail read access is a restricted scope, so Google's
verification is only needed if you offer this to people outside your household.

One email connection per person: Google or IMAP.
