import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
// @ts-ignore TS5097: Node tests load TypeScript sources directly.
import { assertUploadAvailable, cleanup, getJob, GateError, MAX_JOB_AGE, quota, reserve, RESULT_AGE, type Bindings } from './gate.ts';

const owner='a'.repeat(64),uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function setup(t:TestContext){
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  sqlite.exec(readFileSync(new URL('../../drizzle/0000_sloppy_meggan.sql',import.meta.url),'utf8').replaceAll('--> statement-breakpoint',''));
  const db={prepare(sql:string){let args:unknown[]=[];return{
    bind(...values:unknown[]){args=values;return this;},async first(){return sqlite.prepare(sql).get(...args as never[])||null;},
    async all(){return{results:sqlite.prepare(sql).all(...args as never[])};},async run(){return sqlite.prepare(sql).run(...args as never[]);},
  };}}as unknown as D1Database;
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw Error('gate must never call a paid provider');});
  return{sqlite,db,fetch};
}
function seed(sqlite:DatabaseSync,n:number,who=owner,kind='rotation',status='failed',time=Date.now(),resultKey:string|null=null){sqlite.prepare('INSERT INTO ai_jobs(id,owner_hash,kind,status,payload_hash,result_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(uuid(n),who,kind,status,'offline-payload',resultKey,time,time);}
function gateError(code:string){return(error:unknown)=>{assert.ok(error instanceof GateError);assert.equal(error.code,code);return true;};}

test('rotation has its own two-per-browser budget and failed attempts still count',async(t)=>{
  const {db,sqlite,fetch}=setup(t);assert.equal((await quota(db,owner)).remaining.rotation,2);
  seed(sqlite,1);assert.equal((await quota(db,owner)).remaining.rotation,1);
  seed(sqlite,2);assert.equal((await quota(db,owner)).remaining.rotation,0);
  assert.equal((await quota(db,owner)).remaining.recognition,8);assert.equal((await quota(db,owner)).remaining.tryOn,3);
  await assert.rejects(reserve(db,uuid(3),owner,'rotation','new'),gateError('quota'));
  assert.equal((await quota(db,'another-browser')).remaining.rotation,2);assert.equal(fetch.mock.callCount(),0);
});

test('site-wide rotation cap is six attempts across all browsers',async(t)=>{
  const {db,sqlite,fetch}=setup(t);
  for(let n=1;n<=6;n++)seed(sqlite,n,`owner-${n}`);
  assert.equal((await quota(db,owner)).remaining.rotation,0);
  await assert.rejects(reserve(db,uuid(7),owner,'rotation','new'),gateError('quota'));
  assert.equal((await quota(db,owner)).remaining.tryOn,3);assert.equal(fetch.mock.callCount(),0);
});

test('rotation reservations share the atomic global active slot with picture generation',async(t)=>{
  const {db,sqlite,fetch}=setup(t);
  const outcomes=await Promise.allSettled([reserve(db,uuid(1),owner,'rotation','first'),reserve(db,uuid(2),'another-browser','tryOn','second')]);
  assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);
  for(const row of outcomes)if(row.status==='rejected')gateError('busy_global')(row.reason);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get()?.n,1);
  assert.equal((await quota(db,owner)).remaining.rotation,1);assert.equal(fetch.mock.callCount(),0);
});

test('video jobs remain recoverable beyond image timeout, then release the slot after two hours without refund',async(t)=>{
  const {db,sqlite,fetch}=setup(t);
  seed(sqlite,1,owner,'rotation','running',Date.now()-MAX_JOB_AGE-60000);
  assert.equal((await getJob(db,uuid(1),owner)).status,'running');
  await assert.rejects(assertUploadAvailable(db),gateError('busy_global'));
  const remaining=(await quota(db,owner)).remaining.rotation;assert.equal(remaining,1);
  sqlite.prepare('UPDATE ai_jobs SET created_at=? WHERE id=?').run(Date.now()-2*60*60*1000-60000,uuid(1));
  await assertUploadAvailable(db);assert.equal((await getJob(db,uuid(1),owner)).status,'failed');
  assert.equal((await quota(db,owner)).remaining.rotation,remaining);assert.equal(fetch.mock.callCount(),0);
});

test('expired rotation cleanup removes both manifest and video, without deleting retained output',async(t)=>{
  const {db,sqlite,fetch}=setup(t);const removed:string[]=[],old=Date.now()-RESULT_AGE-1000;
  const rotationKey=`ai-results/${owner}/${uuid(1)}.rotation.json`,pictureKey=`ai-results/${owner}/${uuid(2)}.json`,retainedKey=`ai-results/${owner}/${uuid(3)}.rotation.json`;
  seed(sqlite,1,owner,'rotation','succeeded',old,rotationKey);seed(sqlite,2,owner,'tryOn','succeeded',old,pictureKey);seed(sqlite,3,owner,'rotation','succeeded',Date.now(),retainedKey);
  const env={DB:db,BUCKET:{async delete(key:string){removed.push(key);}}}as unknown as Bindings;
  await cleanup(env);
  assert.deepEqual(removed.sort(),[rotationKey,`${rotationKey}.mp4`,pictureKey].sort());
  assert.equal(sqlite.prepare('SELECT result_key FROM ai_jobs WHERE id=?').get(uuid(1))?.result_key,null);
  assert.equal(sqlite.prepare('SELECT result_key FROM ai_jobs WHERE id=?').get(uuid(3))?.result_key,retainedKey);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get()?.n,3);assert.equal(fetch.mock.callCount(),0);
});
