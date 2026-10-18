# Security

Report vulnerabilities privately through GitHub's
[security advisory form](https://github.com/ravimody/fridgedoor/security/advisories/new),
not in a public issue. Include the version or commit, how to reproduce it, and the impact
you expect. You'll get a reply within a week.

Fridgedoor handles family email and calendars, so these count as security bugs:

- anything that lets one household member see another's private plans or email
- anything that lets someone without an account read or change data
- secrets or email content leaking into logs or responses
- email content making the AI take actions it shouldn't

If you run your own server, keep it updated (run the installer again, or download the
new `compose.yaml` and run `docker compose pull && docker compose up -d` with the same
`--profile` you started it with), and serve it over HTTPS. Behind a proxy, set
`TRUST_PROXY=true` (see [HTTPS explained](docs/hosting/https.md#behind-a-proxy-two-settings)).
Protect your backups and `secret.key`: anyone with both can read the household's data.

Sign-in is protected against password guessing. Wrong passwords are rate-limited per
address and per account. The account-wide limit only slows guessing down: the right
password always gets through it, so a stranger can't lock someone out by guessing. An
address that has made too many failed attempts is refused for a while, which is why
`TRUST_PROXY` matters: without it, every visitor shares the proxy's address.
