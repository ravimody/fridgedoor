import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {migrate} from '../db/migrate.js';
import {identityFromPayload} from './access.js';
import {observeAccessSubject,promoteAccessSubjects} from './access-migration.js';
function setup(){const db=new Database(':memory:');migrate(db);db.prepare("INSERT INTO households VALUES ('h','2026-09-19')").run();db.prepare("INSERT INTO members (id,household_id,access_subject,display_name,timezone,active,created_at) VALUES ('a','h','owner@example.test','Owner','America/New_York',1,'2026-09-19')").run();return db;}
it('records a verified subject without rebinding an email-keyed member, then promotes explicitly',()=>{
  const db=setup();const identity=identityFromPayload({sub:'stable-subject',email:'owner@example.test'},'email')!;
  observeAccessSubject(db,identity);expect(db.prepare('SELECT access_subject FROM members').get()).toEqual({access_subject:'owner@example.test'});
  expect(promoteAccessSubjects(db)).toEqual({migrated:1});expect(db.prepare('SELECT access_subject FROM members').get()).toEqual({access_subject:'stable-subject'});db.close();
});
it('never promotes an unobserved, stale, ambiguous or unknown identity',()=>{
  const db=setup();expect(()=>promoteAccessSubjects(db)).toThrow('VERIFIED_SUBJECT_REQUIRED');
  observeAccessSubject(db,{subject:'unknown@example.test',email:'unknown@example.test',verifiedSubject:'foreign'});
  expect(db.prepare('SELECT count(*) n FROM access_subject_observations').get()).toEqual({n:0});
  observeAccessSubject(db,{subject:'owner@example.test',email:'owner@example.test',verifiedSubject:'stable'},new Date('2000-01-01'));
  expect(()=>promoteAccessSubjects(db)).toThrow('VERIFIED_SUBJECT_REQUIRED');
  observeAccessSubject(db,{subject:'owner@example.test',email:'owner@example.test',verifiedSubject:'changed'});
  expect(()=>promoteAccessSubjects(db)).toThrow('VERIFIED_SUBJECT_REQUIRED');
  expect(identityFromPayload({email:'owner@example.test'},'email')).toBeNull();db.close();
});
