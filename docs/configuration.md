# Configuration

Fridgedoor works with no configuration: it creates its secret on first start, learns its
public address during setup, generates Web Push keys, and takes AI, email and Google
settings from the web app. Environment variables (in `.env` for Docker Compose) override
anything set in the web app.

## Server

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | learned at setup | Address people use, e.g. `https://fridgedoor.example.com`. Sign-in, invites and pairing links use it. Render, Railway and Fly addresses are detected as the default. |
| `PORT` | `8080` | Port inside the container. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database, `secret.key` and backups. |
| `DATABASE_PATH` | `$DATA_DIR/fridgedoor.sqlite` | |
| `SESSION_SECRET` | generated into `$DATA_DIR/secret.key` | 32+ characters. Encrypts stored data; don't lose it. |
| `FRIDGEDOOR_ROLE` | `all` | `api` or `worker` to run the web server and background worker as separate containers (both need the same data volume). |
| `SETUP_TOKEN` | generated | Choose the first-run setup token yourself (16+ characters). |
| `HOST` | `0.0.0.0` | Interface to listen on. |
| `BACKUP_KEEP` | `7` | Daily database copies kept in `$DATA_DIR/backups`; `0` turns them off. |
| `TRUST_PROXY` | `false` | `true` when the server is reachable only through a reverse proxy (Caddy, Tailscale, cloudflared) so sign-in limits use the visitor's address from `X-Forwarded-For`. The installer sets it for those modes. |

## AI

Setting `AI_PROVIDER` makes the environment the source of truth; the web app shows AI
settings read-only. See [ai-providers.md](ai-providers.md).

| Variable | Meaning |
| --- | --- |
| `AI_PROVIDER` | `openai`, `anthropic`, `gemini`, `openrouter`, `groq`, `mistral`, `deepseek`, `xai`, `together`, `fireworks`, `azure-openai`, `ollama`, `lmstudio`, `llamacpp`, `vllm`, `custom` |
| `AI_API_KEY` | Provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` also accepted for those providers) |
| `AI_BASE_URL` | For local servers, `custom`, `azure-openai`, or a proxy |
| `AI_MODEL` | Main model (assistant, briefs, knowledge) |
| `AI_MODEL_EMAIL` | Optional model for reading email (defaults to `AI_MODEL`) |
| `AI_MODEL_REVIEW` | Optional stronger model that extracts plans from the emails the email model flags |
| `AI_MODEL_TRANSCRIBE` | Voice transcription model (OpenAI and Groq) |
| `AI_STRUCTURED_OUTPUT` | `json_schema` (default), `json_object` or `prompt` for OpenAI-compatible servers |
| `AI_EXTRACT_EFFORT` | `none`, `low`, `medium` or `high` reasoning effort for email extraction, where supported |
| `AI_ENABLED=false` | Turn off background email reading |
| `ASSISTANT_ENABLED=false` | Turn off the assistant |

## Google (optional)

| Variable | Meaning |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client for Gmail and Google Calendar ([email.md](email.md)). Also settable in Settings → Server. |

## Push notifications

| Variable | Meaning |
| --- | --- |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push keys; generated and saved automatically when unset. |
| `PUSH_PROVIDER=fake` | Disable delivery (tests and previews). |

## Behind an identity proxy (optional)

If you already protect the server with Cloudflare Access, Fridgedoor can additionally
require a valid Access identity for the web app. Most installs should leave these unset.

To add someone, first allow their email in your Access policy, then send them an invite
link from Settings. They sign in through Access, and joining links their new account to
that Access identity.

| Variable | Meaning |
| --- | --- |
| `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, `ACCESS_JWKS_URL` | Cloudflare Access application settings |
| `ACCESS_SUBJECT_MODE` | `sub` (default) or `email` |

## Docker Compose helpers

| Variable | Meaning |
| --- | --- |
| `FRIDGEDOOR_IMAGE` | Image to run (default `ghcr.io/ravimody/fridgedoor:latest`) |
| `FRIDGEDOOR_PORT`, `FRIDGEDOOR_BIND` | Published port and interface; use `127.0.0.1` behind Caddy, Tailscale or Cloudflare |
| `DOMAIN` | `caddy` profile: your domain |
| `TS_AUTHKEY`, `TS_HOSTNAME` | `tailscale` profile |
| `TUNNEL_TOKEN` | `cloudflare` profile |

## Command line

Run inside the container (`docker compose exec fridgedoor fridgedoor <command>`):

| Command | What it does |
| --- | --- |
| `setup-link` | Print the first-run setup link again. |
| `reset-password <email>` | Give an account a new random password and print it. |
| `public-url <url>` | Change the public address (restart afterwards). |
| `backup [path]` | Write a consistent database copy to `$DATA_DIR/backups/`. Keep `secret.key` with it. |
| `members` | List members and their sign-in emails. |
| `add-login <member-id> <email> [owner\|member]` | Give an existing member (for example one created for Cloudflare Access) a password sign-in. |
