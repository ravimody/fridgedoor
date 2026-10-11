import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// Everything is optional so a bare `docker run` works: the server generates its
// secret on first start and learns its public address during setup. Environment
// variables override settings saved in the web app.
const optional = z.string().trim().min(1).optional();
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATA_DIR: z.string().default('./data'),
  DATABASE_PATH: optional,
  /** The address people use to reach the server, such as https://fridgedoor.example.com. */
  PUBLIC_URL: z.string().url().optional(),
  APP_ORIGIN: z.string().url().optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  /** `all` runs the web server and background worker in one process. */
  FRIDGEDOOR_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  SETUP_TOKEN: z.string().min(16).optional(),
  /** Daily database copies kept in DATA_DIR/backups; 0 turns them off. */
  BACKUP_KEEP: z.coerce.number().int().min(0).max(365).default(7),
  /** Set when the server is only reachable through a reverse proxy that sets X-Forwarded-For (Caddy, Tailscale, cloudflared). */
  TRUST_PROXY: z.enum(['true', 'false']).optional(),
  PUSH_PROVIDER: z.enum(['fake', 'webpush']).optional(),
  VAPID_PUBLIC_KEY: optional, VAPID_PRIVATE_KEY: optional, VAPID_SUBJECT: optional,
  GOOGLE_CLIENT_ID: optional, GOOGLE_CLIENT_SECRET: optional,
  // Optional: also require a Cloudflare Access identity in front of the web app.
  ACCESS_ISSUER: z.string().url().optional(), ACCESS_AUDIENCE: optional, ACCESS_JWKS_URL: z.string().url().optional(),
  ACCESS_SUBJECT_MODE: z.enum(['sub', 'email']).optional(),
  // AI. Setting AI_PROVIDER makes the environment the source of truth for AI settings.
  AI_PROVIDER: optional, AI_API_KEY: optional, AI_BASE_URL: z.string().url().optional(),
  AI_STRUCTURED_OUTPUT: z.enum(['json_schema', 'json_object', 'prompt']).optional(),
  AI_MODEL: optional, AI_MODEL_EMAIL: optional, AI_MODEL_REVIEW: optional, AI_MODEL_TRANSCRIBE: optional,
  AI_EXTRACT_EFFORT: z.enum(['none', 'low', 'medium', 'high']).optional(),
  /** Kill switches: `false` turns off background email reading or the assistant even when a model is configured. */
  AI_ENABLED: z.enum(['true', 'false']).optional(), ASSISTANT_ENABLED: z.enum(['true', 'false']).optional(),
  // Older names, still accepted.
  OPENAI_API_KEY: optional, ANTHROPIC_API_KEY: optional, AI_MODEL_CHAT: optional, AI_MODEL_EXTRACT: optional,
}).superRefine((value, ctx) => {
  if (Boolean(value.VAPID_PUBLIC_KEY) !== Boolean(value.VAPID_PRIVATE_KEY)) ctx.addIssue({ code: 'custom', path: ['VAPID_PUBLIC_KEY'], message: 'VAPID public and private keys must be set together' });
  if (value.ACCESS_JWKS_URL && (!value.ACCESS_ISSUER || !value.ACCESS_AUDIENCE)) ctx.addIssue({ code: 'custom', path: ['ACCESS_JWKS_URL'], message: 'Cloudflare Access needs ACCESS_ISSUER, ACCESS_AUDIENCE and ACCESS_JWKS_URL together' });
  if (Boolean(value.GOOGLE_CLIENT_ID) !== Boolean(value.GOOGLE_CLIENT_SECRET)) ctx.addIssue({ code: 'custom', path: ['GOOGLE_CLIENT_ID'], message: 'Google OAuth client ID and secret must be configured together' });
});

type Parsed = z.infer<typeof configSchema>;
/** Resolved configuration. `APP_ORIGIN` may be updated in place once setup records the public address. */
export type AppConfig = Partial<Omit<Parsed, 'NODE_ENV' | 'DATABASE_PATH' | 'SESSION_SECRET' | 'APP_ORIGIN'>> & {
  NODE_ENV: Parsed['NODE_ENV'];
  DATABASE_PATH: string;
  SESSION_SECRET: string;
  APP_ORIGIN: string;
  /** True when APP_ORIGIN came from PUBLIC_URL/APP_ORIGIN rather than setup. */
  ORIGIN_FROM_ENV?: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(env);
  const origin = parsed.PUBLIC_URL ?? parsed.APP_ORIGIN;
  return {
    ...parsed,
    DATABASE_PATH: parsed.DATABASE_PATH ?? join(parsed.DATA_DIR, 'fridgedoor.sqlite'),
    SESSION_SECRET: parsed.SESSION_SECRET ?? (parsed.NODE_ENV === 'test' ? 'test-session-secret-change-me-1234567890' : dataSecret(parsed.DATA_DIR)),
    APP_ORIGIN: new URL(origin ?? platformUrl(env) ?? `http://localhost:${parsed.PORT}`).origin,
    ORIGIN_FROM_ENV: Boolean(origin),
  };
}

/** Hosting platforms that announce the app's public address; only a default until setup records the real one. */
function platformUrl(env: NodeJS.ProcessEnv) {
  if (env.RENDER_EXTERNAL_URL) return env.RENDER_EXTERNAL_URL;
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  if (env.FLY_APP_NAME) return `https://${env.FLY_APP_NAME}.fly.dev`;
  return undefined;
}

/** Reads or creates the server's encryption secret beside the database. Back it up with the data: without it, stored tokens can't be read. */
export function dataSecret(dataDir: string): string {
  const path = join(dataDir, 'secret.key');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(path, `${secret}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return secret;
}
