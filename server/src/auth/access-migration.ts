import type Database from 'better-sqlite3';
import type { AccessIdentity } from './access.js';
// Only call after issuer/audience/signature verification, while using email mode.
export function observeAccessSubject(db: Database.Database, identity: AccessIdentity, now = new Date()) {
  if(!identity.verifiedSubject || !identity.email || identity.subject!==identity.email) return;
  const member=db.prepare('SELECT id FROM members WHERE active=1 AND access_subject=?').get(identity.subject) as {id:string}|undefined;
  if(!member) return;
  db.prepare(`INSERT INTO access_subject_observations VALUES (?,?,?,0,?) ON CONFLICT(member_id) DO UPDATE SET
    conflicted=CASE WHEN access_subject_observations.verified_subject<>excluded.verified_subject OR access_subject_observations.previous_subject<>excluded.previous_subject THEN 1 ELSE access_subject_observations.conflicted END,
    observed_at=excluded.observed_at`).run(member.id,identity.subject,identity.verifiedSubject,now.toISOString());
}
export function promoteAccessSubjects(db: Database.Database, now = new Date()) {
  return db.transaction(()=>{
    const rows=db.prepare(`SELECT m.id,m.access_subject,o.previous_subject,o.verified_subject,o.conflicted,o.observed_at FROM members m LEFT JOIN access_subject_observations o ON o.member_id=m.id WHERE m.active=1`).all() as Array<{id:string;access_subject:string;previous_subject:string|null;verified_subject:string|null;conflicted:number|null;observed_at:string|null}>;
    if(!rows.length || rows.some(row=>!row.verified_subject || row.conflicted || !row.observed_at || Date.parse(row.observed_at)<now.getTime()-7*86400000 || ![row.previous_subject,row.verified_subject].includes(row.access_subject))) throw new Error('VERIFIED_SUBJECT_REQUIRED');
    if(new Set(rows.map(row=>row.verified_subject)).size!==rows.length) throw new Error('SUBJECT_CONFLICT');
    for(const row of rows) {
      if(db.prepare('SELECT 1 FROM members WHERE access_subject=? AND id<>?').get(row.verified_subject,row.id))throw new Error('SUBJECT_CONFLICT');
    }
    for(const row of rows)db.prepare('UPDATE members SET access_subject=? WHERE id=?').run(row.verified_subject,row.id);
    return {migrated:rows.length};
  })();
}
