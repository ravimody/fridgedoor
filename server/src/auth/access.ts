import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import type { AppConfig } from '../config.js';

export type AccessIdentity = { subject: string; email?: string; verifiedSubject?: string };
export type AccessVerifier = (token: string) => Promise<AccessIdentity | null>;
export type MemberRecord = { id: string; householdId: string; accessSubject: string; allowedEmail?: string; displayName: string; timezone: string; active: boolean };

/** Optional Cloudflare Access verification; undefined when the server uses its own sign-in only. */
export function createAccessVerifier(config: AppConfig): AccessVerifier | undefined {
  if (!config.ACCESS_JWKS_URL || !config.ACCESS_ISSUER || !config.ACCESS_AUDIENCE) return undefined;
  const keys = createRemoteJWKSet(new URL(config.ACCESS_JWKS_URL));
  return async (token) => {
    try { const { payload } = await jwtVerify(token, keys as unknown as Parameters<typeof jwtVerify>[1], { issuer: config.ACCESS_ISSUER!, audience: config.ACCESS_AUDIENCE! }); return identityFromPayload(payload, config.ACCESS_SUBJECT_MODE ?? 'sub'); } catch { return null; }
  };
}
export function identityFromPayload(payload: JWTPayload, subjectMode: 'sub'|'email' = 'sub'): AccessIdentity | null { const email = typeof payload.email === 'string' ? payload.email : undefined; if(typeof payload.sub!=='string' || !payload.sub.trim() || subjectMode==='email' && !email) return null; return subjectMode==='email' ? {subject:email!,email:email!,verifiedSubject:payload.sub} : {subject:payload.sub,...(email?{email}:{})}; }
export function bearerToken(header: string | undefined): string | null { if (!header?.startsWith('Bearer ')) return null; const token = header.slice(7).trim(); return token ? token : null; }
