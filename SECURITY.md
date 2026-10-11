# Security

Please report vulnerabilities privately through GitHub's
[security advisory form](https://github.com/ravimody/fridgedoor/security/advisories/new)
rather than a public issue. Include the version or commit, how to reproduce, and the
impact you expect. You'll get a reply within a week.

Fridgedoor handles family email and calendars, so we treat these as security bugs:
anything that lets one household member see another's private plans or email, lets
someone without an account read or change data, leaks secrets or email content into
logs or responses, or lets email content make the AI take actions it shouldn't.

Running your own server? Keep it updated (`docker compose pull && docker compose up -d`),
serve it over HTTPS, and protect backups together with `secret.key`.
