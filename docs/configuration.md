# Configuration

Fridgedoor works with no configuration. It creates its secret on first start, learns its
public address during setup, generates Web Push keys, and takes AI, email and Google
settings from the web app. Environment variables (in `.env` for Docker Compose) override
anything set in the web app.

## Server

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | learned at setup | Address people use, e.g. `https://fridgedoor.example.com`. Sign-in, invites and pairing codes use it. On Render, Railway and Fly the platform address is the default until setup records one. |
| `PORT` | `8080` | Port inside the container. |
| `HOST` | `0.0.0.0` | Interface to listen on. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database, `secret.key` and backups. |
| `DATABASE_PATH` | `$DATA_DIR/fridgedoor.sqlite` | Database file. Daily backups go in a `backups` folder next to it. |
| `SESSION_SECRET` | generated into `$DATA_DIR/secret.key` | 32+ characters. Encrypts stored data, so don't lose it. |
| `FRIDGEDOOR_ROLE` | `all` | `api` or `worker` to run the web server and background worker as separate containers (both need the same data volume). |
| `SETUP_TOKEN` | generated | Choose the first-run setup token yourself (16+ characters). |
| `BACKUP_KEEP` | `7` | Daily database copies to keep; `0` turns them off. |
| `TRUST_PROXY` | `false` | Set to `true` when the server is reachable only through a reverse proxy (Caddy, Tailscale, cloudflared, or a platform such as Fly, Render or Railway), so sign-in limits use the visitor's address instead of the proxy's. The installer, `fly.toml` and `render.yaml` set it. |
| `CLIENT_IP_HEADER` | unset | With `TRUST_PROXY=true`: a header the platform's edge always overwrites with the visitor's address. Unset, the right-most valid address in `X-Forwarded-For` is used, which suits Caddy and Tailscale. Use `CF-Connecting-IP` for Cloudflare Tunnel and Render, `Fly-Client-IP` for Fly and `X-Real-IP` for Railway. See [HTTPS explained](hosting/https.md#behind-a-proxy-two-settings). |

## AI

Setting `AI_PROVIDER` makes the environment the source of truth, and the web app then
shows the AI settings read-only. See [ai-providers.md](ai-providers.md).

| Variable | Meaning |
| --- | --- |
| `AI_PROVIDER` | `openai`, `anthropic`, `gemini`, `openrouter`, `groq`, `mistral`, `deepseek`, `xai`, `together`, `fireworks`, `azure-openai`, `ollama`, `lmstudio`, `llamacpp`, `vllm`, `custom` |
| `AI_API_KEY` | Provider key. With `AI_PROVIDER=openai` or `anthropic`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` also works. |
| `AI_BASE_URL` | Required for `azure-openai` and `custom`. Also for local servers on another address, or a proxy. |
| `AI_MODEL` | Main model (the planner, morning brief, household facts) |
| `AI_MODEL_EMAIL` | Optional model for reading email (defaults to `AI_MODEL`) |
| `AI_MODEL_REVIEW` | Optional stronger model. The email model then only screens each message, and the review model extracts plans from the ones it flags. |
| `AI_MODEL_TRANSCRIBE` | Voice transcription model. Defaults to a speech model for OpenAI and Groq. |
| `AI_STRUCTURED_OUTPUT` | `json_schema` (default), `json_object` or `prompt`. Applies to OpenAI-compatible providers only. |
| `AI_EXTRACT_EFFORT` | `none`, `low`, `medium` or `high` reasoning effort for reading email, where the model supports it. Ignored when `AI_MODEL_REVIEW` is set. |
| `AI_ENABLED=false` | Turn off background email reading. |
| `ASSISTANT_ENABLED=false` | Turn off the planner. |

## Google (optional)

| Variable | Meaning |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client for Gmail and Google Calendar ([email.md](email.md)). You can also set them in Settings → Server. |

## Push notifications

| Variable | Meaning |
| --- | --- |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push keys and contact. The keys are generated and saved automatically when unset, and the subject defaults to the public address. |
| `PUSH_PROVIDER=fake` | Turn off delivery (tests and previews). |

## Behind an identity proxy (optional)

If you already protect the server with Cloudflare Access, Fridgedoor can also require a
valid Access identity for the web app. Most installs should leave these unset.

The person who opens the setup link must arrive through Access. Setup links their Access
identity to the new household's first account, which is the owner. To add someone, first
allow their email in your Access policy, then send them an invite link from Settings.
They sign in through Access, and joining links their new account to that Access
identity.

| Variable | Meaning |
| --- | --- |
| `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, `ACCESS_JWKS_URL` | Cloudflare Access application settings |
| `ACCESS_SUBJECT_MODE` | `sub` (default) or `email` |

## Owners and members

The person who creates the household during setup is its owner. Owners manage the AI
provider, the server address and Google settings (Settings → AI and Settings → Server),
invites and members. Everyone else is a member. An owner can be added later with
`fridgedoor add-login <member-id> <email> owner` for a member who has no password
sign-in yet; `fridgedoor members` lists member ids.

## Docker Compose helpers

| Variable | Meaning |
| --- | --- |
| `FRIDGEDOOR_IMAGE` | Image to run (default `ghcr.io/ravimody/fridgedoor:latest`, the newest release; `:main` follows the main branch, for testers). The Caddy, Tailscale and cloudflared images are pinned to versions in `compose.yaml` and change only when you download a new `compose.yaml`. |
| `FRIDGEDOOR_PORT`, `FRIDGEDOOR_BIND` | Published port (default `8080`) and interface (default `0.0.0.0`). Use `127.0.0.1` behind Caddy, Tailscale or Cloudflare. |
| `DOMAIN` | `caddy` profile: your domain |
| `TS_AUTHKEY`, `TS_HOSTNAME` | `tailscale` profile: auth key and machine name (default `fridgedoor`) |
| `TS_SERVE_FILE` | `tailscale` profile: `tailscale-serve-private.json` to keep the address inside your tailnet instead of using Funnel |
| `TUNNEL_TOKEN` | `cloudflare` profile |

## Command line

Run these inside the container (`docker compose exec fridgedoor fridgedoor <command>`):

| Command | What it does |
| --- | --- |
| `setup-link` | Print the first-run setup link again. |
| `reset-password <email>` | Give an account a new random password and print it. |
| `public-url <url>` | Change the public address (restart afterwards). |
| `backup [path]` | Write a consistent database copy (default: the `backups` folder next to the database, the same place as the daily copies). Keep `secret.key` with it. |
| `members` | List members and their sign-in emails. |
| `add-login <member-id> <email> [owner\|member]` | Give an existing member who has no password sign-in (for example one who joined through Cloudflare Access) a password and print it. The member becomes an owner unless you add `member`. |
