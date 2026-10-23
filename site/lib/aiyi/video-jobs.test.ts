import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
// @ts-ignore TS5097: Node tests load TypeScript sources directly.
import { createVideoJob, readVideoJob, readVideoMedia } from './video-jobs.ts';
// @ts-ignore TS5097: Node tests load TypeScript sources directly.
import { getJob, GateError, RESULT_AGE, type Bindings } from './gate.ts';
// @ts-ignore TS5097: Node tests load TypeScript sources directly.
import { ProviderError } from './providers.ts';

const owner='a'.repeat(64), other='b'.repeat(64);
const taskId='00000000-0000-4000-8000-000000000001', remoteId='cgt-offline-fixture-1';
const input={image:'data:image/png;base64,iVBORw0KGgoBAgME'};
const videoUrl='https://ark-content.volccdn.com/fixture.mp4?signature=offline';
const key=(who=owner,id=taskId)=>`ai-results/${who}/${id}.rotation.json`;
function video(){const bytes=new Uint8Array(32),data=new DataView(bytes.buffer);data.setUint32(0,24);bytes.set(new TextEncoder().encode('ftypisom'),4);bytes.set(new TextEncoder().encode('mp42iso2'),16);data.setUint32(24,8);bytes.set(new TextEncoder().encode('mdat'),28);return bytes;}
function mockFetch(t:TestContext,handler:(request:Request)=>Response|Promise<Response>){return t.mock.method(globalThis,'fetch',async(value:string|URL|Request,init?:RequestInit)=>handler(value instanceof Request?value:new Request(value,init)));}
function isGate(code:string){return(error:unknown)=>{assert.ok(error instanceof GateError);assert.equal(error.code,code);return true;};}
function setup(t:TestContext){
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  sqlite.exec(readFileSync(new URL('../../drizzle/0000_sloppy_meggan.sql',import.meta.url),'utf8').replaceAll('--> statement-breakpoint',''));
  let failSql:((sql:string)=>boolean)|null=null;
  const db={prepare(sql:string){let args:unknown[]=[];return{
    bind(...values:unknown[]){args=values;return this;},
    async first(){if(failSql?.(sql))throw Error('offline write failure');return sqlite.prepare(sql).get(...args as never[])||null;},
    async all(){return{results:sqlite.prepare(sql).all(...args as never[])};},
    async run(){if(failSql?.(sql))throw Error('offline write failure');return sqlite.prepare(sql).run(...args as never[]);},
  };}}as unknown as D1Database;
  const objects=new Map<string,string|Uint8Array>(),puts:Array<{key:string;body:string|Uint8Array}>=[],gets:string[]=[];
  let failPut:((key:string,body:string|Uint8Array)=>boolean)|null=null;
  const bucket={
    async put(objectKey:string,value:string|Uint8Array){if(failPut?.(objectKey,value))throw Error('offline R2 write failure');const copy=typeof value==='string'?value:new Uint8Array(value);objects.set(objectKey,copy);puts.push({key:objectKey,body:copy});return{};},
    async head(objectKey:string){const value=objects.get(objectKey);return value===undefined?null:{key:objectKey,size:typeof value==='string'?new TextEncoder().encode(value).length:value.length};},
    async get(objectKey:string){gets.push(objectKey);const value=objects.get(objectKey);if(value===undefined)return null;const bytes=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value);return{size:bytes.length,body:new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);c.close();}}),async json<T>(){return JSON.parse(new TextDecoder().decode(bytes))as T;},async arrayBuffer(){return bytes.buffer;}};},
    async delete(objectKey:string){objects.delete(objectKey);},
  }as unknown as R2Bucket;
  const env={DB:db,BUCKET:bucket,AIYI_ACCESS_CODE:'offline-code',AIYI_IMAGE_KEY:'offline-image-key',AIYI_RECOGNITION_KEY:'offline-vision-key',AIYI_VIDEO_KEY:'offline-ark-key'}as Bindings;
  function manifest(){const text=objects.get(key());assert.equal(typeof text,'string');return JSON.parse(text as string)as Record<string,unknown>;}
  return{env,sqlite,objects,puts,gets,manifest,setFailPut(value:typeof failPut){failPut=value;},setFailSql(value:typeof failSql){failSql=value;}};
}
async function ownedJob(env:Bindings){return getJob(env.DB,taskId,owner);}
function providerResult(status='queued'){return Response.json({id:remoteId,status,...(status==='succeeded'?{content:{video_url:videoUrl}}:{})});}

test('same request ID and all recovery queries use exactly one paid POST',async(t)=>{
  const ctx=setup(t);let paid=0,queries=0;
  const fetch=mockFetch(t,request=>{if(request.method==='POST'){paid++;return Response.json({id:remoteId});}queries++;assert.ok(request.url.endsWith(remoteId));return providerResult('running');});
  assert.equal((await createVideoJob(ctx.env,owner,taskId,input)).status,'queued');
  assert.equal((await createVideoJob(ctx.env,owner,taskId,input)).status,'running');
  assert.equal((await readVideoJob(ctx.env,owner,await ownedJob(ctx.env))).status,'running');
  assert.equal(paid,1);assert.equal(queries,2);assert.equal(fetch.mock.callCount(),3);
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get()?.n,1);
});

test('unapproved or malformed source mapping fails before any quota, recovery writes or paid request',async(t)=>{
  const ctx=setup(t);ctx.env.AIYI_VIDEO_MODEL='doubao-seedance-2-0-260128';
  const fetch=mockFetch(t,()=>{throw Error('must not call');});
  for(const mapping of [undefined,'{}','{"hq-model-02":"asset://asset-20261024123456-offline"}','{"hq-model-01":"https://private.invalid/image.png"}']){
    ctx.env.AIYI_VIDEO_ASSETS=mapping;
    await assert.rejects(createVideoJob(ctx.env,owner,taskId,{sourceId:'hq-model-01'}),error=>{assert.ok(error instanceof ProviderError);assert.ok(['portrait_required','configuration_error'].includes(error.code));assert.equal(error.message.includes('private.invalid'),false);return true;});
  }
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get()?.n,0);
  assert.equal(ctx.puts.length,0);assert.equal(fetch.mock.callCount(),0);
});

test('approved source jobs retain one paid call and can recover after source mapping changes or disappears',async(t)=>{
  const ctx=setup(t),assetUri='asset://asset-20261024123456-offline';
  ctx.env.AIYI_VIDEO_MODEL='doubao-seedance-2-0-260128';ctx.env.AIYI_VIDEO_ASSETS=JSON.stringify({'hq-model-01':assetUri});
  let paid=0,queries=0;
  mockFetch(t,async request=>{
    if(request.method==='POST'){
      paid++;assert.equal(ctx.manifest().phase,'submitting');
      const payload=await request.json()as{content:Array<{image_url?:{url:string}}>};assert.equal(payload.content[1].image_url?.url,assetUri);
      return Response.json({id:remoteId});
    }
    queries++;return providerResult('running');
  });
  const original={sourceId:'hq-model-01'}as const;
  assert.equal((await createVideoJob(ctx.env,owner,taskId,original)).status,'queued');
  ctx.env.AIYI_VIDEO_ASSETS=JSON.stringify({'hq-model-01':'asset://asset-20261024123457-another'});
  assert.equal((await createVideoJob(ctx.env,owner,taskId,original)).status,'running');
  delete ctx.env.AIYI_VIDEO_ASSETS;
  assert.equal((await createVideoJob(ctx.env,owner,taskId,original)).status,'running');
  assert.equal((await readVideoJob(ctx.env,owner,await ownedJob(ctx.env))).status,'running');
  await assert.rejects(createVideoJob(ctx.env,owner,taskId,{sourceId:'hq-model-02'}),isGate('request_conflict'));
  await assert.rejects(createVideoJob(ctx.env,owner,taskId,input),isGate('request_conflict'));
  await assert.rejects(createVideoJob(ctx.env,other,taskId,original),isGate('not_found'));
  assert.equal(paid,1);assert.equal(queries,3);assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get()?.n,1);
  assert.equal(JSON.stringify(ctx.manifest()).includes(assetUri),false);
});

test('provider task ID is durably persisted before the first provider query',async(t)=>{
  const ctx=setup(t);let count=0;
  mockFetch(t,request=>{count++;if(request.method==='POST'){assert.equal(ctx.manifest().phase,'submitting');assert.equal(ctx.sqlite.prepare('SELECT result_key FROM ai_jobs WHERE id=?').get(taskId)?.result_key,key());return Response.json({id:remoteId});}assert.equal(ctx.manifest().phase,'accepted');assert.equal(ctx.manifest().remoteId,remoteId);return providerResult();});
  await createVideoJob(ctx.env,owner,taskId,input);assert.equal(count,1);
  assert.equal(ctx.manifest().remoteId,remoteId);
  await readVideoJob(ctx.env,owner,await ownedJob(ctx.env));assert.equal(count,2);
});

test('uncertain submission stays actionable and never resubmits on repeated POST-ID or GET recovery',async(t)=>{
  const ctx=setup(t);const fetch=mockFetch(t,request=>{assert.equal(request.method,'POST');throw Error('offline interrupted submission');});
  const created=await createVideoJob(ctx.env,owner,taskId,input);assert.equal(created.status,'running');assert.equal(created.needsAttention,true);assert.equal(ctx.manifest().phase,'unknown');
  for(let n=0;n<3;n++){const result=await readVideoJob(ctx.env,owner,await ownedJob(ctx.env));assert.equal(result.needsAttention,true);assert.equal(result.status,'running');}
  const repeated=await createVideoJob(ctx.env,owner,taskId,input);assert.equal(repeated.needsAttention,true);
  assert.equal(fetch.mock.callCount(),1);assert.equal(ctx.manifest().remoteId,undefined);
});

test('failed recovery metadata preparation prevents any paid upstream call',async(t)=>{
  const ctx=setup(t);ctx.setFailPut(()=>true);const fetch=mockFetch(t,()=>{throw Error('must not call');});
  await assert.rejects(createVideoJob(ctx.env,owner,taskId,input),isGate('storage'));
  assert.equal(fetch.mock.callCount(),0);assert.equal(ctx.sqlite.prepare('SELECT status FROM ai_jobs WHERE id=?').get(taskId)?.status,'failed');
});

test('failed D1 manifest association also prevents any paid call',async(t)=>{
  const ctx=setup(t);ctx.setFailSql(sql=>sql.startsWith('UPDATE ai_jobs SET result_key='));const fetch=mockFetch(t,()=>{throw Error('must not call');});
  await assert.rejects(createVideoJob(ctx.env,owner,taskId,input),isGate('storage'));assert.equal(fetch.mock.callCount(),0);
  assert.equal(ctx.manifest().phase,'failed');assert.equal(ctx.sqlite.prepare('SELECT status FROM ai_jobs WHERE id=?').get(taskId)?.status,'failed');
  const recovered=await readVideoJob(ctx.env,owner,await ownedJob(ctx.env));assert.equal(recovered.status,'failed');assert.match(recovered.message||'',/未调用视频模型/);assert.equal(fetch.mock.callCount(),0);
});

test('accepted ID persistence failure reports uncertainty and querying never sends another POST',async(t)=>{
  const ctx=setup(t);ctx.setFailPut((_key,body)=>typeof body==='string'&&JSON.parse(body).phase==='accepted');
  const fetch=mockFetch(t,()=>Response.json({id:remoteId}));
  const result=await createVideoJob(ctx.env,owner,taskId,input);assert.equal(result.needsAttention,true);assert.equal(ctx.manifest().phase,'submitting');
  assert.equal((await readVideoJob(ctx.env,owner,await ownedJob(ctx.env))).status,'running');assert.equal(fetch.mock.callCount(),1);
});

test('video download failure can recover on a later query without a second paid POST',async(t)=>{
  const ctx=setup(t);let paid=0,queries=0,downloads=0;
  mockFetch(t,request=>{if(request.method==='POST'){paid++;return Response.json({id:remoteId});}if(request.url.includes('/contents/generations/tasks/')){queries++;return providerResult('succeeded');}downloads++;assert.equal(request.headers.get('authorization'),null);if(downloads===1)throw Error('offline CDN interruption');return new Response(video(),{headers:{'Content-Type':'video/mp4'}});});
  await createVideoJob(ctx.env,owner,taskId,input);
  const first=await readVideoJob(ctx.env,owner,await ownedJob(ctx.env));assert.equal(first.status,'running');assert.equal(first.needsAttention,true);assert.equal(ctx.manifest().phase,'accepted');
  const second=await readVideoJob(ctx.env,owner,await ownedJob(ctx.env));assert.equal(second.status,'succeeded');assert.deepEqual(second.result,{mediaPath:`/api/ai/rotation-media/${taskId}`});
  assert.equal(paid,1);assert.equal(queries,2);assert.equal(downloads,2);
  assert.equal(ctx.sqlite.prepare('SELECT status FROM ai_jobs WHERE id=?').get(taskId)?.status,'succeeded');
  assert.ok(ctx.objects.get(`${key()}.mp4`)instanceof Uint8Array);
});

test('success exposes only a protected same-origin media path and cached query does not refetch provider',async(t)=>{
  const ctx=setup(t);let paid=0,queries=0,downloads=0;
  const fetch=mockFetch(t,request=>{if(request.method==='POST'){paid++;return Response.json({id:remoteId});}if(request.url.includes('/contents/generations/tasks/')){queries++;return providerResult('succeeded');}downloads++;return new Response(video(),{headers:{'Content-Type':'video/mp4'}});});
  await createVideoJob(ctx.env,owner,taskId,input);
  const complete=await readVideoJob(ctx.env,owner,await ownedJob(ctx.env));
  assert.deepEqual(complete,{taskId,status:'succeeded',result:{mediaPath:`/api/ai/rotation-media/${taskId}`}});
  assert.ok(!JSON.stringify(complete).includes(remoteId));assert.ok(!JSON.stringify(complete).includes(videoUrl));assert.ok(!JSON.stringify(complete).includes(key()));
  assert.deepEqual(await readVideoJob(ctx.env,owner,await ownedJob(ctx.env)),complete);
  assert.deepEqual(await createVideoJob(ctx.env,owner,taskId,input),complete);
  const media=await readVideoMedia(ctx.env,owner,taskId);assert.equal(media.size,32);
  assert.equal(paid,1);assert.equal(queries,1);assert.equal(downloads,1);assert.equal(fetch.mock.callCount(),3);
});

test('different owner cannot recover, replace or download another owner video',async(t)=>{
  const ctx=setup(t);const fetch=mockFetch(t,()=>Response.json({id:remoteId}));
  await createVideoJob(ctx.env,owner,taskId,input);
  await assert.rejects(getJob(ctx.env.DB,taskId,other),isGate('not_found'));
  await assert.rejects(createVideoJob(ctx.env,other,taskId,input),isGate('not_found'));
  await assert.rejects(readVideoMedia(ctx.env,other,taskId),isGate('not_found'));
  await assert.rejects(readVideoJob(ctx.env,other,await ownedJob(ctx.env)),isGate('not_found'));
  assert.equal(fetch.mock.callCount(),1);
});

test('a lost saved video is downloaded again from the original task without a second paid POST',async(t)=>{
  const ctx=setup(t);let paid=0,queries=0,downloads=0;
  mockFetch(t,request=>{if(request.method==='POST'){paid++;return Response.json({id:remoteId});}if(request.url.includes('/contents/generations/tasks/')){queries++;return providerResult('succeeded');}downloads++;return new Response(video(),{headers:{'Content-Type':'video/mp4'}});});
  await createVideoJob(ctx.env,owner,taskId,input);
  assert.equal((await readVideoJob(ctx.env,owner,await ownedJob(ctx.env))).status,'succeeded');
  ctx.objects.delete(`${key()}.mp4`);
  await assert.rejects(readVideoMedia(ctx.env,owner,taskId),isGate('not_found'));
  assert.equal((await readVideoJob(ctx.env,owner,await ownedJob(ctx.env))).status,'succeeded');
  assert.ok(ctx.objects.get(`${key()}.mp4`)instanceof Uint8Array);
  assert.equal(ctx.manifest().remoteId,remoteId);assert.equal(ctx.manifest().phase,'succeeded');
  assert.equal(paid,1);assert.equal(queries,2);assert.equal(downloads,2);
});

test('submitted model is retained in the manifest when deployment configuration changes',async(t)=>{
  const ctx=setup(t);ctx.env.AIYI_VIDEO_MODEL='ep-original';let submits=0;
  mockFetch(t,async request=>{if(request.method==='POST'){submits++;const body=await request.json()as{model:string};assert.equal(body.model,'ep-original');return Response.json({id:remoteId});}assert.equal(ctx.manifest().model,'ep-original');return providerResult('running');});
  await createVideoJob(ctx.env,owner,taskId,input);ctx.env.AIYI_VIDEO_MODEL='ep-replacement';
  await readVideoJob(ctx.env,owner,await ownedJob(ctx.env));assert.equal(ctx.manifest().model,'ep-original');assert.equal(submits,1);
});

test('expired local retention returns failed and rejects media without any upstream request',async(t)=>{
  const ctx=setup(t);const fetch=mockFetch(t,()=>{throw Error('must not call');});
  const old=Date.now()-RESULT_AGE-1;
  ctx.sqlite.prepare('INSERT INTO ai_jobs(id,owner_hash,kind,status,payload_hash,result_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(taskId,owner,'rotation','succeeded','fixture',key(),old,old);
  ctx.objects.set(key(),JSON.stringify({version:1,provider:'volcengine',model:'ep-original',phase:'succeeded',createdAt:old,mediaKey:`${key()}.mp4`}));ctx.objects.set(`${key()}.mp4`,video());
  assert.equal((await readVideoJob(ctx.env,owner,await ownedJob(ctx.env))).status,'failed');
  await assert.rejects(readVideoMedia(ctx.env,owner,taskId),isGate('not_found'));assert.equal(fetch.mock.callCount(),0);
});

test('provider failure is recorded once and never resubmitted on recovery',async(t)=>{
  const ctx=setup(t);let paid=0,queries=0;
  const fetch=mockFetch(t,request=>{if(request.method==='POST'){paid++;return Response.json({id:remoteId});}queries++;return providerResult('failed');});
  await createVideoJob(ctx.env,owner,taskId,input);
  assert.equal((await readVideoJob(ctx.env,owner,await ownedJob(ctx.env))).status,'failed');assert.equal(ctx.manifest().phase,'failed');
  assert.equal((await readVideoJob(ctx.env,owner,await ownedJob(ctx.env))).status,'failed');assert.equal((await createVideoJob(ctx.env,owner,taskId,input)).status,'failed');
  assert.equal(paid,1);assert.equal(queries,1);assert.equal(fetch.mock.callCount(),2);
});
