import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { digest } from '../crypto.js';
import type { MemberRecord } from './access.js';
import { burnPasswordCheck, hashPassword, PASSWORD_MAX, PASSWORD_MIN, verifyPassword } from './passwords.js';

type Clock = () => Date;
export type Role = 'owner' | 'member';
const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const PAIRING_TTL_MS = 10 * 60_000;

const validZone = (zone: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; } };
export const profileInput = z.object({
  displayName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
  timezone: z.string().min(1).max(64).refine(validZone, 'Unknown time zone'),
}).strict();
export const setupInput = profileInput.extend({ householdName: z.string().trim().min(1).max(80) }).strict();
export type ProfileInput = z.infer<typeof profileInput>;

const memberColumns = 'm.id, m.household_id as householdId, m.access_subject as accessSubject, m.allowed_email as allowedEmail, m.display_name as displayName, m.timezone, m.active';
type MemberRow = Omit<MemberRecord, 'active'> & { active: number | boolean };
const asMember = (row: MemberRow): MemberRecord => ({ ...row, active: Boolean(row.active) });
const newId = () => randomBytes(16).toString('hex');

/** Built-in households and accounts: first-run setup, email/password sign-in, invites and phone pairing. */
export class AccountService {
  constructor(private readonly db: Database.Database, private readonly clock: Clock = () => new Date()) {}

  /** True until someone creates the first household. Servers behind an identity proxy with seeded members never need setup. */
  setupRequired() { return !this.db.prepare('SELECT 1 FROM members LIMIT 1').get(); }

  async createHousehold(input: z.infer<typeof setupInput>): Promise<MemberRecord> {
    const parsed = setupInput.parse(input);
    const passwordHash = await hashPassword(parsed.password);
    return this.db.transaction(() => {
      if (!this.setupRequired()) throw new Error('SETUP_ALREADY_DONE');
      const householdId = newId(); const now = this.clock().toISOString();
      this.db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run(householdId, now);
      this.db.prepare('INSERT INTO household_profiles (household_id, name, updated_at) VALUES (?, ?, ?)').run(householdId, parsed.householdName, now);
      return this.insertMember(householdId, parsed, passwordHash, 'owner');
    })();
  }

  async login(email: string, password: string): Promise<MemberRecord | null> {
    const row = this.db.prepare(`SELECT ${memberColumns}, l.password_hash as passwordHash FROM member_logins l JOIN members m ON m.id = l.member_id WHERE l.email = ?`).get(email.trim().toLowerCase()) as (MemberRow & { passwordHash: string }) | undefined;
    if (!row) { await burnPasswordCheck(password); return null; }
    if (!(await verifyPassword(password, row.passwordHash)) || !row.active) return null;
    const { passwordHash: _hash, ...member } = row; void _hash;
    return asMember(member);
  }

  role(memberId: string): Role | undefined {
    return (this.db.prepare('SELECT role FROM member_logins WHERE member_id = ?').get(memberId) as { role: Role } | undefined)?.role;
  }

  /** People who can manage the household: owners, or anyone when the household has no password accounts (identity-proxy installs). */
  canManage(member: MemberRecord) {
    if (this.role(member.id) === 'owner') return true;
    return !this.db.prepare("SELECT 1 FROM member_logins l JOIN members m ON m.id = l.member_id WHERE m.household_id = ? AND l.role = 'owner' AND m.active = 1").get(member.householdId);
  }

  householdName(householdId: string) {
    return (this.db.prepare('SELECT name FROM household_profiles WHERE household_id = ?').get(householdId) as { name: string } | undefined)?.name ?? 'Our household';
  }

  renameHousehold(member: MemberRecord, name: string) {
    const parsed = z.string().trim().min(1).max(80).parse(name);
    this.db.prepare('INSERT INTO household_profiles (household_id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(household_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at').run(member.householdId, parsed, this.clock().toISOString());
    return { name: parsed };
  }

  household(member: MemberRecord) {
    const manage = this.canManage(member);
    const members = (this.db.prepare(`SELECT ${memberColumns}, l.email, l.role FROM members m LEFT JOIN member_logins l ON l.member_id = m.id WHERE m.household_id = ? ORDER BY m.created_at`).all(member.householdId) as Array<MemberRow & { email: string | null; role: Role | null }>)
      .map((row) => ({ id: row.id, displayName: row.displayName, active: Boolean(row.active), role: row.role ?? 'member', ...(manage && row.email ? { email: row.email } : {}) }));
    const invites = manage ? this.db.prepare('SELECT id, created_at as createdAt, expires_at as expiresAt FROM household_invites WHERE household_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at').all(member.householdId, this.clock().toISOString()) as Array<{ id: string; createdAt: string; expiresAt: string }> : [];
    return { name: this.householdName(member.householdId), canManage: manage, members, invites };
  }

  createInvite(member: MemberRecord) {
    if (!this.canManage(member)) throw new Error('FORBIDDEN');
    const token = randomBytes(24).toString('base64url'); const id = newId(); const now = this.clock();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
    this.db.prepare('INSERT INTO household_invites (id, household_id, token_digest, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, member.householdId, digest(token), member.id, expiresAt, now.toISOString());
    return { id, token, expiresAt };
  }

  revokeInvite(member: MemberRecord, id: string) {
    if (!this.canManage(member)) throw new Error('FORBIDDEN');
    const result = this.db.prepare('UPDATE household_invites SET revoked_at = ? WHERE id = ? AND household_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(this.clock().toISOString(), id, member.householdId);
    if (result.changes !== 1) throw new Error('NOT_FOUND');
    return { revoked: true };
  }

  private openInvite(token: string) {
    return this.db.prepare('SELECT i.id, i.household_id as householdId, m.display_name as invitedBy FROM household_invites i JOIN members m ON m.id = i.created_by WHERE i.token_digest = ? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?').get(digest(token), this.clock().toISOString()) as { id: string; householdId: string; invitedBy: string } | undefined;
  }

  inviteInfo(token: string) {
    const invite = this.openInvite(token);
    return invite ? { householdName: this.householdName(invite.householdId), invitedBy: invite.invitedBy } : null;
  }

  /** Behind Cloudflare Access, `accessSubject` is the joiner's verified Access identity, so the new member can be matched on later visits. */
  async acceptInvite(token: string, input: ProfileInput, accessSubject?: string): Promise<MemberRecord> {
    const parsed = profileInput.parse(input);
    const passwordHash = await hashPassword(parsed.password);
    return this.db.transaction(() => {
      const invite = this.openInvite(token);
      if (!invite) throw new Error('INVITE_INVALID');
      // A removed member keeps their row; the owner restores them rather than creating a second one.
      const existing = accessSubject ? this.db.prepare('SELECT active FROM members WHERE access_subject = ?').get(accessSubject) as { active: number } | undefined : undefined;
      if (existing) throw new Error(existing.active ? 'ALREADY_MEMBER' : 'MEMBER_REMOVED');
      const member = this.insertMember(invite.householdId, parsed, passwordHash, 'member', accessSubject);
      this.db.prepare('UPDATE household_invites SET used_at = ?, used_by = ? WHERE id = ?').run(this.clock().toISOString(), member.id, invite.id);
      return member;
    })();
  }

  setActive(actor: MemberRecord, memberId: string, active: boolean) {
    if (!this.canManage(actor)) throw new Error('FORBIDDEN');
    if (memberId === actor.id && !active) throw new Error('CANNOT_REMOVE_SELF');
    const result = this.db.prepare('UPDATE members SET active = ? WHERE id = ? AND household_id = ?').run(active ? 1 : 0, memberId, actor.householdId);
    if (result.changes !== 1) throw new Error('NOT_FOUND');
    if (!active) this.revokeAll(memberId);
    return { active };
  }

  async changePassword(member: MemberRecord, current: string, next: string, keepSessionId?: string) {
    const row = this.db.prepare('SELECT password_hash as hash FROM member_logins WHERE member_id = ?').get(member.id) as { hash: string } | undefined;
    if (!row || !(await verifyPassword(current, row.hash))) throw new Error('PASSWORD_INCORRECT');
    await this.setPassword(member.id, next, keepSessionId);
  }

  /**
   * Also used by the `reset-password` command. A new password signs out every other
   * browser and phone, in case the old one was compromised; `keepSessionId` keeps the
   * browser that made the change.
   */
  async setPassword(memberId: string, password: string, keepSessionId?: string) {
    const parsed = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX).parse(password);
    const result = this.db.prepare('UPDATE member_logins SET password_hash = ?, updated_at = ? WHERE member_id = ?').run(await hashPassword(parsed), this.clock().toISOString(), memberId);
    if (result.changes !== 1) throw new Error('NOT_FOUND');
    this.revokeAll(memberId, keepSessionId);
  }

  /** The sign-in email of a password account. */
  email(memberId: string) { return (this.db.prepare('SELECT email FROM member_logins WHERE member_id = ?').get(memberId) as { email: string } | undefined)?.email; }

  /** Members of every household with their sign-in email, for the admin CLI. */
  listMembers() {
    return this.db.prepare('SELECT m.id, m.household_id as householdId, m.display_name as displayName, m.active, l.email, l.role FROM members m LEFT JOIN member_logins l ON l.member_id = m.id ORDER BY m.household_id, m.created_at').all() as Array<{ id: string; householdId: string; displayName: string; active: number; email: string | null; role: Role | null }>;
  }

  /** Gives an existing member (for example one created for Cloudflare Access) a password sign-in. */
  async addLogin(memberId: string, email: string, password: string, role: Role) {
    const parsed = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX) }).parse({ email, password });
    const hash = await hashPassword(parsed.password); const now = this.clock().toISOString();
    this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM members WHERE id = ?').get(memberId)) throw new Error('NOT_FOUND');
      if (this.db.prepare('SELECT 1 FROM member_logins WHERE member_id = ?').get(memberId)) throw new Error('LOGIN_EXISTS');
      if (this.db.prepare('SELECT 1 FROM member_logins WHERE email = ?').get(parsed.email)) throw new Error('EMAIL_IN_USE');
      this.db.prepare('INSERT INTO member_logins (member_id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(memberId, parsed.email, hash, role, now, now);
    })();
  }

  memberIdForEmail(email: string) {
    return (this.db.prepare('SELECT member_id as id FROM member_logins WHERE email = ?').get(email.trim().toLowerCase()) as { id: string } | undefined)?.id;
  }

  createPairingCode(member: MemberRecord) {
    const code = randomBytes(24).toString('base64url'); const now = this.clock();
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();
    this.db.prepare('INSERT INTO device_pairing_codes (code_digest, member_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(digest(code), member.id, expiresAt, now.toISOString());
    return { code, expiresAt };
  }

  /** One use only; returns the member the code was made for. Throws PAIRING_CODE_USED, PAIRING_CODE_EXPIRED or PAIRING_CODE_INVALID so the phone can say which. */
  consumePairingCode(code: string): string {
    const now = this.clock().toISOString();
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT member_id as memberId, used_at as usedAt, expires_at as expiresAt FROM device_pairing_codes WHERE code_digest = ?').get(digest(code)) as { memberId: string; usedAt: string | null; expiresAt: string } | undefined;
      if (!row) throw new Error('PAIRING_CODE_INVALID');
      if (row.usedAt) throw new Error('PAIRING_CODE_USED');
      if (row.expiresAt <= now) throw new Error('PAIRING_CODE_EXPIRED');
      this.db.prepare('UPDATE device_pairing_codes SET used_at = ? WHERE code_digest = ?').run(now, digest(code));
      return row.memberId;
    })();
  }

  private insertMember(householdId: string, input: ProfileInput, passwordHash: string, role: Role, accessSubject?: string): MemberRecord {
    if (this.db.prepare('SELECT 1 FROM member_logins WHERE email = ?').get(input.email)) throw new Error('EMAIL_IN_USE');
    const id = newId(); const now = this.clock().toISOString(); const subject = accessSubject ?? `local:${id}`;
    this.db.prepare('INSERT INTO members (id, household_id, access_subject, allowed_email, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').run(id, householdId, subject, input.email, input.displayName, input.timezone, now);
    this.db.prepare('INSERT INTO member_logins (member_id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, input.email, passwordHash, role, now, now);
    return { id, householdId, accessSubject: subject, allowedEmail: input.email, displayName: input.displayName, timezone: input.timezone, active: true };
  }

  private revokeAll(memberId: string, keepSessionId?: string) {
    const now = this.clock().toISOString();
    this.db.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL AND id <> ?').run(now, memberId, keepSessionId ?? '');
    this.db.prepare('UPDATE calendar_feeds SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(now, memberId);
    this.db.prepare("UPDATE native_sessions SET revoked_at = ?, revoke_reason = 'member_removed' WHERE member_id = ? AND revoked_at IS NULL").run(now, memberId);
    this.db.prepare('DELETE FROM native_access_tokens WHERE session_id IN (SELECT id FROM native_sessions WHERE member_id = ?)').run(memberId);
  }
}

/** Active members, as the request pipeline sees them. */
export function loadActiveMembers(db: Database.Database): MemberRecord[] {
  return (db.prepare(`SELECT ${memberColumns} FROM members m WHERE m.active = 1`).all() as MemberRow[]).map(asMember);
}

/**
 * In-memory limiter for guessable secrets (passwords, setup tokens). Only failures count,
 * so a person can always sign in after typing their password right. Old keys are evicted
 * instead of clearing everything, so flooding new keys can't reset someone's counter.
 */
export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit = 10, private readonly windowMs = 15 * 60_000, private readonly clock: Clock = () => new Date(), private readonly maxKeys = 50_000) {}
  private recent(key: string) { const now = this.clock().getTime(); return (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs); }
  blocked(key: string, limit = this.limit) { return this.recent(key).length >= limit; }
  fail(key: string) {
    const recent = this.recent(key); recent.push(this.clock().getTime());
    this.hits.delete(key); this.hits.set(key, recent);
    if (this.hits.size <= this.maxKeys) return;
    for (const [candidate] of this.hits) { if (!this.recent(candidate).length) this.hits.delete(candidate); }
    // Still full: drop the least recently touched keys (Map keeps insertion order).
    for (const [candidate] of this.hits) { if (this.hits.size <= this.maxKeys) break; this.hits.delete(candidate); }
  }
  /** For endpoints where every attempt counts: false once the limit is reached. */
  allow(key: string) { if (this.blocked(key)) return false; this.fail(key); return true; }
  reset(key: string) { this.hits.delete(key); }
}
