import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MemberRecord } from './access.js';

export type Clock = () => Date;
export type SessionData = { id: string; member: MemberRecord; csrfToken: string };
type Row = { id: string; token_digest: string; member_id: string; csrf_ciphertext: string; csrf_iv: string; csrf_tag: string; expires_at: string; revoked_at: string | null };
// `__Host-` cookies require HTTPS; plain-HTTP installs (a LAN address) fall back to a normal name.
const secureName = '__Host-fridgedoor-session';
const plainName = 'fridgedoor-session';
export function sessionCookie(token: string, maxAge = 604800, secure = true) { return `${secure ? secureName : plainName}=${token}; Max-Age=${maxAge}; Path=/;${secure ? ' Secure;' : ''} HttpOnly; SameSite=Lax`; }
export function expiredCookie(secure = true) { return `${secure ? secureName : plainName}=; Max-Age=0; Path=/;${secure ? ' Secure;' : ''} HttpOnly; SameSite=Lax`; }
export function readCookie(header: string | undefined) { const parts = header?.split(';').map((part) => part.trim()) ?? []; for (const name of [secureName, plainName]) { const found = parts.find((part) => part.startsWith(`${name}=`)); if (found) return found.slice(name.length + 1); } return null; }
export function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
export class SessionStore {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly now: Clock = () => new Date()) {}
  private encrypt(value: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv); const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return { ciphertext: ciphertext.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }; }
  private decrypt(row: Row) { const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.csrf_iv, 'base64url')); decipher.setAuthTag(Buffer.from(row.csrf_tag, 'base64url')); return Buffer.concat([decipher.update(Buffer.from(row.csrf_ciphertext, 'base64url')), decipher.final()]).toString('utf8'); }
  create(member: MemberRecord) { const token = randomBytes(32).toString('base64url'); const csrfToken = randomBytes(32).toString('base64url'); const encrypted = this.encrypt(csrfToken); const id = randomBytes(16).toString('hex'); const now = this.now(); this.db.prepare('INSERT INTO browser_sessions (id, token_digest, member_id, csrf_ciphertext, csrf_iv, csrf_tag, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, digest(token), member.id, encrypted.ciphertext, encrypted.iv, encrypted.tag, new Date(now.getTime() + 604800000).toISOString(), now.toISOString()); return { token, data: { id, member, csrfToken } satisfies SessionData }; }
  find(token: string | null, member: MemberRecord, loadMember: (id: string) => MemberRecord | null): SessionData | null { if (!token) return null; const row = this.db.prepare('SELECT * FROM browser_sessions WHERE token_digest = ?').get(digest(token)) as Row | undefined; if (!row || row.revoked_at || row.expires_at <= this.now().toISOString()) return null; const current = loadMember(row.member_id); if (!current || !current.active || current.id !== member.id) return null; return { id: row.id, member: current, csrfToken: this.decrypt(row) }; }
  /** Finds a session from its cookie alone (password sign-in, where no outer identity exists). */
  lookup(token: string | null, loadMember: (id: string) => MemberRecord | null): SessionData | null { if (!token) return null; const row = this.db.prepare('SELECT member_id FROM browser_sessions WHERE token_digest = ?').get(digest(token)) as { member_id: string } | undefined; const member = row ? loadMember(row.member_id) : null; return member ? this.find(token, member, loadMember) : null; }
  revokeOthers(memberId: string, keepId: string) { this.db.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE member_id = ? AND id <> ? AND revoked_at IS NULL').run(this.now().toISOString(), memberId, keepId); }
  verifyCsrf(session: SessionData, supplied: string | undefined) { if (!supplied) return false; const a = Buffer.from(session.csrfToken); const b = Buffer.from(supplied); return a.length === b.length && timingSafeEqual(a, b); }
  revoke(sessionId: string) { this.db.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE id = ?').run(this.now().toISOString(), sessionId); }
}
