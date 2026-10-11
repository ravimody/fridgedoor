import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { decryptJson, encryptJson } from '../crypto.js';
import type { GoogleGrant, GoogleProvider } from '../providers/google.js';

type Connection = { id: string; member_id: string; generation: number; encrypted_tokens: string; google_sub: string };

/** Shared by API and worker; a database lease serializes refresh across processes. */
export class GoogleTokenService {
  constructor(private readonly db: Database.Database, private readonly key: Buffer,
    private readonly provider: Pick<GoogleProvider, 'refresh'>,
    private readonly clock: () => Date = () => new Date()) {}

  private connection(connectionId: string, generation: number): Connection {
    const row = this.db.prepare(`SELECT g.id, g.member_id, g.generation, g.encrypted_tokens, g.google_sub
      FROM google_connections g JOIN members m ON m.id = g.member_id
      WHERE g.id = ? AND g.generation = ? AND g.status = 'active' AND m.active = 1`)
      .get(connectionId, generation) as Connection | undefined;
    if (!row) throw new Error('GOOGLE_CONNECTION_INACTIVE');
    return row;
  }

  async grant(connectionId: string, generation: number): Promise<GoogleGrant> {
    const token = randomBytes(24).toString('hex');
    const claimed = this.db.transaction(() => {
      const row = this.connection(connectionId, generation);
      const grant = decryptJson<GoogleGrant>(JSON.parse(row.encrypted_tokens), this.key, `google-connection:${row.id}`);
      if (grant.sub !== row.google_sub) throw new Error('GOOGLE_ACCOUNT_MISMATCH');
      if (Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > this.clock().getTime() + 60000) {
        return { row, grant, refresh: false };
      }
      const timestamp = this.clock().toISOString();
      const lease = this.db.prepare(`INSERT INTO google_refresh_leases (connection_id, token, expires_at)
        VALUES (?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET token = excluded.token,
        expires_at = excluded.expires_at WHERE google_refresh_leases.expires_at <= ?`)
        .run(row.id, token, new Date(this.clock().getTime() + 60000).toISOString(), timestamp);
      if (lease.changes !== 1) throw new Error('GOOGLE_REFRESH_BUSY');
      return { row, grant, refresh: true };
    })();
    if (!claimed.refresh) return claimed.grant;
    const { row, grant } = claimed;
    // All persistence checks both the original grant and the lease after network I/O.
    const condition = `id = ? AND generation = ? AND status = 'active' AND encrypted_tokens = ?
      AND EXISTS (SELECT 1 FROM members m WHERE m.id = google_connections.member_id AND m.active = 1)
      AND EXISTS (SELECT 1 FROM google_refresh_leases l WHERE l.connection_id = google_connections.id
        AND l.token = ? AND l.expires_at > ?)`;
    const parameters = () => [row.id, generation, row.encrypted_tokens, token, this.clock().toISOString()];
    try {
      const refreshed = await this.provider.refresh(grant);
      if (refreshed.sub !== row.google_sub || refreshed.email !== grant.email) throw new Error('GOOGLE_ACCOUNT_MISMATCH');
      if (!refreshed.refreshToken?.trim() || !refreshed.accessToken?.trim() ||
        !(Date.parse(refreshed.expiresAt) > this.clock().getTime() + 60000)) throw new Error('GOOGLE_REFRESH_FAILED');
      const encrypted = JSON.stringify(encryptJson(refreshed, this.key, `google-connection:${row.id}`));
      const saved = this.db.prepare(`UPDATE google_connections SET encrypted_tokens = ?, grants_json = ?, updated_at = ? WHERE ${condition}`)
        .run(encrypted, JSON.stringify(refreshed.scopes), this.clock().toISOString(), ...parameters());
      if (saved.changes !== 1) throw new Error('GOOGLE_CONNECTION_CHANGED');
      return refreshed;
    } catch (error) {
      if (error instanceof Error && error.message === 'GOOGLE_REAUTH_REQUIRED') {
        this.db.prepare(`UPDATE google_connections SET status = 'needs_reauth', generation = generation + 1,
          revision = revision + 1, updated_at = ? WHERE ${condition}`)
          .run(this.clock().toISOString(), ...parameters());
      }
      throw error;
    } finally {
      this.db.prepare('DELETE FROM google_refresh_leases WHERE connection_id = ? AND token = ?').run(row.id, token);
    }
  }
}
