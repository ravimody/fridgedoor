# Fridgedoor web app

React 19 + Vite, served by the server at `/dashboard/` in production.

## Develop

Run the API and the web app in two terminals from the repository root:

```sh
pnpm --filter @fridgedoor/contracts build
PUBLIC_URL=http://127.0.0.1:4173 DATA_DIR=./data-dev pnpm --filter @fridgedoor/server dev
pnpm --filter @fridgedoor/web dev
```

Open <http://127.0.0.1:4173/dashboard/>. Vite proxies `/dashboard/api`,
`/dashboard/native`, `/dashboard/google`, `/native`, `/calendar` and `/healthz` to the
server on port 8080 (set `FRIDGEDOOR_API` to use another address). The proxy keeps the
browser's `Host` and `Origin`, and the server only accepts sign-ins and changes from its
public address, so `PUBLIC_URL` must be the Vite address exactly: `127.0.0.1`, not
`localhost`.

On a fresh data directory the server prints a setup link
(`http://127.0.0.1:4173/dashboard/setup?token=…`) in its log; open it to create a
household. Set `SETUP_TOKEN` to a fixed value of 16+ characters if you reset the data
often.

Checks: `pnpm --filter @fridgedoor/web test`, `pnpm --filter @fridgedoor/web typecheck`,
`pnpm --filter @fridgedoor/web lint`.
