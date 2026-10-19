import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { assertUploadAvailable, authorize, checkOrigin, GateError, getJob, MAX_JOB_AGE, quota, reserve, type Bindings } from './gate.ts';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../drizzle/0000_sloppy_meggan.sql', import.meta.url), 'utf8').replaceAll('--> statement-breakpoint',''));
  const db = { prepare(sql: string) { let values: unknown[] = []; return {
    bind(...args: unknown[]) { values = args; return this; },
    async first() { return sqlite.prepare(sql).get(...values as never[]) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...values as never[]) }; },
    async run() { return sqlite.prepare(sql).run(...values as never[]); },
  }; } } as unknown as D1Database;
  return { sqlite, db };
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner = 'a'.repeat(64);
function seed(sqlite: DatabaseSync, n: number, who: string, kind = 'tryOn', status = 'failed', time = Date.now()) {
  sqlite.prepare('INSERT INTO ai_jobs(id,owner_hash,kind,status,payload_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(uuid(n), who, kind, status, 'payload', time, time);
}
test('same-origin checks reject cross-site and hostile Origin', () => {
  assert.throws(() => checkOrigin(new Request('https://example.test/api', {headers:{Origin:'https://attacker.test'}})));
  assert.throws(() => checkOrigin(new Request('https://example.test/api', {headers:{'Sec-Fetch-Site':'cross-site'}})));
  assert.doesNotThrow(() => checkOrigin(new Request('https://example.test/api', {headers:{Origin:'https://example.test'}})));
});
test('two empty upload preflights can pass but concurrent reservations take only one paid slot', async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  await Promise.all([assertUploadAvailable(db), assertUploadAvailable(db)]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get()?.n, 0);
  assert.equal((await quota(db, owner)).remaining.tryOn, 3);
  const outcomes = await Promise.allSettled([reserve(db, uuid(1), owner, 'tryOn', 'one'), reserve(db, uuid(2), 'b'.repeat(64), 'tryOn', 'two')]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') assert.equal(outcome.value.created, true);
    else {
      assert.ok(outcome.reason instanceof GateError);
      assert.equal(outcome.reason.code, 'busy_global');
    }
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get()?.n, 1);
});
test('a live task blocks upload globally without spending quota and remains available to its owner', async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const other = 'b'.repeat(64);
  seed(sqlite, 1, other, 'tryOn', 'running');
  const rowsBefore = sqlite.prepare('SELECT * FROM ai_jobs').all();
  const quotasBefore = [await quota(db, owner), await quota(db, other)];
  await assert.rejects(assertUploadAvailable(db), (error: unknown) => {
    assert.ok(error instanceof GateError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'busy_global');
    return true;
  });
  const job = await getJob(db, uuid(1), other);
  assert.equal(job.status, 'running');
  assert.equal(job.owner_hash, other);
  assert.equal((await reserve(db, uuid(1), other, 'tryOn', 'payload')).created, false);
  assert.deepEqual(sqlite.prepare('SELECT * FROM ai_jobs').all(), rowsBefore);
  assert.deepEqual([await quota(db, owner), await quota(db, other)], quotasBefore);
});
test('reusing identical request does not create another charge; changed payload conflicts', async () => {
  const { db } = database();
  assert.equal((await reserve(db, uuid(1), owner, 'tryOn', 'same')).created, true);
  assert.equal((await reserve(db, uuid(1), owner, 'tryOn', 'same')).created, false);
  await assert.rejects(reserve(db, uuid(1), owner, 'tryOn', 'changed'), (e: unknown) => (e as {code:string}).code === 'request_conflict');
  await assert.rejects(getJob(db, uuid(1), 'other'), (e: unknown) => (e as {status:number}).status === 404);
});
test('per-browser cap and site-wide cap include failed attempts', async () => {
  const { db, sqlite } = database();
  for(let i=1;i<=3;i++) seed(sqlite,i,owner);
  assert.equal((await quota(db,owner)).remaining.tryOn,0);
  await assert.rejects(reserve(db,uuid(4),owner,'tryOn','new'), (e: unknown) => (e as {code:string}).code === 'quota');
  for(let i=4;i<=12;i++)seed(sqlite,i,`other-${i}`);
  assert.equal((await quota(db,'new-browser')).remaining.tryOn,0);
  await assert.rejects(reserve(db,uuid(13),'new-browser','tryOn','new'), (e: unknown) => (e as {code:string}).code === 'quota');
});
test('upload preflight releases a stale task without restoring its spent charge budget', async (t) => {
  const { db, sqlite }=database(); t.after(() => sqlite.close());
  seed(sqlite,1,'other','tryOn','running',Date.now()-MAX_JOB_AGE-60000);
  const before = await quota(db, 'other');
  assert.equal(before.remaining.tryOn, 2);
  await assertUploadAvailable(db);
  assert.equal(sqlite.prepare('SELECT status FROM ai_jobs WHERE id=?').get(uuid(1))?.status,'failed');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get()?.n,1);
  assert.deepEqual(await quota(db, 'other'), before);
  const result=await reserve(db,uuid(2),owner,'tryOn','new'); assert.equal(result.created,true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get()?.n,2);
});
test('code authorizes only with valid browser capability; bad attempts never reveal secrets', async()=>{
  const {db}=database(); const env={DB:db,BUCKET:{},AIYI_ACCESS_CODE:'testing-code-unique'} as Bindings;
  const req=(code:string)=>new Request('https://example.test/api/ai/status',{headers:{'X-Aiyi-Code':code,'CF-Connecting-IP':'192.0.2.1'}});
  const id='a'.repeat(40);
  await assert.rejects(authorize(req('wrong'),env,id), (e:unknown)=>(e as {status:number}).status===401);
  assert.match(await authorize(req('testing-code-unique'),env,id),/^[0-9a-f]{64}$/);
  await assert.rejects(authorize(req('testing-code-unique'),env,'bad'), (e:unknown)=>(e as {status:number}).status===400);
  for(let i=0;i<10;i++)await authorize(req('wrong'),env,id).catch(()=>{});
  await assert.rejects(authorize(req('wrong'),env,id), (e:unknown)=>(e as {status:number}).status===429);
  await assert.rejects(authorize(req('testing-code-unique'),env,id), (e:unknown)=>(e as {status:number}).status===429);
});
