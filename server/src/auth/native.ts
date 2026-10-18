import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { digest } from '../crypto.js';
import type { MemberRecord } from './access.js';
import type { Clock } from './session.js';

// The iOS app registers this scheme; ASWebAuthenticationSession captures the
// redirect itself, so other apps cannot observe the one-time code.
export const NATIVE_REDIRECT_URI = 'fridgedoor://auth/callback';
const CODE_TTL_MS = 2 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60_000;
// A phone can lose the response to a refresh it sent (suspension, timeout). Reusing the
// rotated token this soon is treated as that retry rather than theft.
const REPLAY_GRACE_MS = 30_000;

export type NativeSession = { sessionId: string; member: MemberRecord };
export type NativeTokens = { accessToken: string; accessTokenExpiresAt: string; refreshToken: string; refreshTokenExpiresAt: string };
type LoadMember = (id: string) => MemberRecord | undefined;

const challengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const sameText = (a: string, b: string) => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const isChallenge = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
const isVerifier = (value: string) => /^[A-Za-z0-9._~-]{43,128}$/.test(value);

export class NativeAuthService {
  constructor(private readonly db: Database.Database, private readonly loadMember: LoadMember, private readonly clock: Clock = () => new Date()) {}

  createCode(member: MemberRecord, codeChallenge: string) {
    if (!isChallenge(codeChallenge)) throw new Error('VALIDATION');
    const code = randomBytes(32).toString('base64url'); const now = this.clock();
    this.db.prepare('INSERT INTO native_auth_codes (code_digest, member_id, code_challenge, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(digest(code), member.id, codeChallenge, new Date(now.getTime() + CODE_TTL_MS).toISOString(), now.toISOString());
    return code;
  }

  exchangeCode(code: string, codeVerifier: string, label: string) {
    if (!isVerifier(codeVerifier)) throw new Error('NATIVE_GRANT_INVALID');
    const now = this.clock().toISOString();
    // Failures return null instead of throwing so the code stays burned after a bad verifier.
    const result = this.db.transaction(() => {
      const row = this.db.prepare('SELECT member_id as memberId, code_challenge as challenge, expires_at as expiresAt, used_at as usedAt FROM native_auth_codes WHERE code_digest = ?').get(digest(code)) as { memberId: string; challenge: string; expiresAt: string; usedAt: string | null } | undefined;
      if (!row || row.usedAt || row.expiresAt <= now) return null;
      this.db.prepare('UPDATE native_auth_codes SET used_at = ? WHERE code_digest = ?').run(now, digest(code));
      const member = this.loadMember(row.memberId);
      if (!sameText(challengeFor(codeVerifier), row.challenge) || !member?.active) return null;
      const sessionId = randomBytes(16).toString('hex');
      this.db.prepare('INSERT INTO native_sessions (id, member_id, label, created_at) VALUES (?, ?, ?, ?)').run(sessionId, member.id, label.trim().slice(0, 80) || 'iPhone', now);
      return { member, tokens: this.issue(sessionId) };
    })();
    if (!result) throw new Error('NATIVE_GRANT_INVALID');
    return result;
  }

  /** Signs a device in for a member whose identity was already proven (a one-time pairing code). */
  startSession(memberId: string, label: string) {
    const member = memberId ? this.loadMember(memberId) : undefined;
    if (!member?.active) throw new Error('NATIVE_GRANT_INVALID');
    const sessionId = randomBytes(16).toString('hex');
    this.db.prepare('INSERT INTO native_sessions (id, member_id, label, created_at) VALUES (?, ?, ?, ?)').run(sessionId, member.id, label.trim().slice(0, 80) || 'iPhone', this.clock().toISOString());
    return { member, tokens: this.issue(sessionId) };
  }

  refresh(refreshToken: string) {
    const now = this.clock().toISOString();
    // Failures return null instead of throwing so replay revocation commits.
    const result = this.db.transaction(() => {
      const row = this.db.prepare('SELECT t.session_id as sessionId, t.expires_at as expiresAt, t.rotated_at as rotatedAt, s.member_id as memberId, s.revoked_at as revokedAt FROM native_refresh_tokens t JOIN native_sessions s ON s.id = t.session_id WHERE t.token_digest = ?').get(digest(refreshToken)) as { sessionId: string; expiresAt: string; rotatedAt: string | null; memberId: string; revokedAt: string | null } | undefined;
      if (!row || row.revokedAt) return null;
      const inGrace = row.rotatedAt !== null && this.clock().getTime() - Date.parse(row.rotatedAt) < REPLAY_GRACE_MS;
      if (row.rotatedAt && !inGrace) { this.revokeSession(row.sessionId, 'refresh_replay'); return null; }
      const member = this.loadMember(row.memberId);
      if (row.expiresAt <= now || !member?.active) return null;
      this.db.prepare('UPDATE native_refresh_tokens SET rotated_at = ? WHERE token_digest = ?').run(now, digest(refreshToken));
      this.db.prepare('DELETE FROM native_access_tokens WHERE session_id = ? AND expires_at <= ?').run(row.sessionId, now);
      return { member, tokens: this.issue(row.sessionId) };
    })();
    if (!result) throw new Error('NATIVE_GRANT_INVALID');
    return result;
  }

  verify(accessToken: string): NativeSession | null {
    if (!accessToken) return null;
    const now = this.clock().toISOString();
    const row = this.db.prepare('SELECT s.id as sessionId, s.member_id as memberId FROM native_access_tokens t JOIN native_sessions s ON s.id = t.session_id WHERE t.token_digest = ? AND t.expires_at > ? AND s.revoked_at IS NULL').get(digest(accessToken), now) as { sessionId: string; memberId: string } | undefined;
    if (!row) return null;
    const member = this.loadMember(row.memberId);
    if (!member?.active) return null;
    this.db.prepare('UPDATE native_sessions SET last_used_at = ? WHERE id = ?').run(now, row.sessionId);
    return { sessionId: row.sessionId, member };
  }

  list(memberId: string) {
    return this.db.prepare('SELECT id, label, created_at as createdAt, last_used_at as lastUsedAt FROM native_sessions WHERE member_id = ? AND revoked_at IS NULL ORDER BY created_at').all(memberId);
  }

  revoke(memberId: string, sessionId: string) {
    const owned = this.db.prepare('SELECT 1 FROM native_sessions WHERE id = ? AND member_id = ? AND revoked_at IS NULL').get(sessionId, memberId);
    if (!owned) throw new Error('NOT_FOUND');
    this.revokeSession(sessionId, 'signed_out');
    return { revoked: true };
  }

  /** Also ends the Share/capture credentials this phone made, so a signed-out phone can't keep adding items. */
  private revokeSession(sessionId: string, reason: string) {
    const now = this.clock().toISOString();
    this.db.prepare('UPDATE native_sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL').run(now, reason, sessionId);
    this.db.prepare('DELETE FROM native_access_tokens WHERE session_id = ?').run(sessionId);
    this.db.prepare("UPDATE capture_credentials SET status = 'revoked', revoked_at = ? WHERE native_session_id = ? AND status = 'active'").run(now, sessionId);
  }

  private issue(sessionId: string): NativeTokens {
    const now = this.clock().getTime();
    const accessToken = `mpa_${randomBytes(32).toString('base64url')}`; const refreshToken = `mpr_${randomBytes(32).toString('base64url')}`;
    const accessTokenExpiresAt = new Date(now + ACCESS_TTL_MS).toISOString(); const refreshTokenExpiresAt = new Date(now + REFRESH_TTL_MS).toISOString();
    this.db.prepare('INSERT INTO native_access_tokens (token_digest, session_id, expires_at) VALUES (?, ?, ?)').run(digest(accessToken), sessionId, accessTokenExpiresAt);
    this.db.prepare('INSERT INTO native_refresh_tokens (token_digest, session_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(digest(refreshToken), sessionId, refreshTokenExpiresAt, new Date(now).toISOString());
    return { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt };
  }
}
