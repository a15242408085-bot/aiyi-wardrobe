import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test, type TestContext } from 'node:test';
// @ts-ignore TS5097: Native Node tests load the TypeScript source directly.
import { ProviderError } from './providers.ts';
// @ts-ignore TS5097: Native Node tests load the TypeScript source directly.
import { createRotation, downloadRotation, queryRotation, rotationModel, validateRotationInput } from './video-provider.ts';

const env = { AIYI_VIDEO_KEY: 'offline-ark-test-only-key' };
const image = `data:image/png;base64,${Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]).toString('base64')}`;
const id = 'cgt-20261024123456-offline';
const media = 'https://ark-content.volccdn.com/video/result.mp4?signature=offline';
function mockFetch(t: TestContext, handler: (request: Request) => Promise<Response> | Response) {
  return t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => handler(input instanceof Request ? input : new Request(input, init)));
}
function errorCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(env.AIYI_VIDEO_KEY));
    assert.ok(!error.message.includes('https://'));
    assert.ok(!error.message.includes('Bearer'));
    return true;
  };
}
function mp4(): Uint8Array {
  const value = Buffer.alloc(32);
  value.writeUInt32BE(24); value.write('ftyp',4); value.write('isom',8); value.write('mp42',16); value.write('iso2',20);
  value.writeUInt32BE(8,24); value.write('mdat',28);
  return value;
}

test('rotation validation reuses bounded image validation without any HTTP', (t) => {
  const fetch = mockFetch(t, () => { throw Error('must not call'); });
  assert.deepEqual(validateRotationInput({image, arbitrary:'discard'}), {image});
  for (const value of [null, {}, {image:'https://example.com/photo.png'}, {image:'data:image/png;base64,AAAA'}, {image:`data:image/png;base64,${'A'.repeat(2600000)}`}]) {
    assert.throws(() => validateRotationInput(value), ProviderError);
  }
  assert.equal(fetch.mock.callCount(),0);
});

test('one explicit fallback model and strict configured model validation', () => {
  assert.equal(rotationModel({}), 'doubao-seedance-1-0-pro-250528');
  assert.equal(rotationModel({AIYI_VIDEO_MODEL:'ep-custom-model-2026'}), 'ep-custom-model-2026');
  for (const value of ['', '../models', 'x?key=secret', 'bad name', 'x'.repeat(121)]) assert.throws(() => rotationModel({AIYI_VIDEO_MODEL:value}), errorCode('configuration_error'));
});

test('create submits exactly one official image-to-video task with the fixed payload', async (t) => {
  const fetch = mockFetch(t, async request => {
    assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
    assert.equal(request.method,'POST'); assert.equal(request.redirect,'manual'); assert.equal(request.credentials,'omit');
    assert.equal(request.headers.get('authorization'),`Bearer ${env.AIYI_VIDEO_KEY}`);
    const body=await request.json() as Record<string,unknown>;
    assert.equal(body.model,'doubao-seedance-1-0-pro-250528');
    assert.equal(body.duration,5); assert.equal(body.resolution,'720p'); assert.equal(body.ratio,'9:16');
    assert.equal(body.camera_fixed,true); assert.equal(body.watermark,false);
    const content=body.content as Array<Record<string,unknown>>;
    assert.equal(content.length,2); assert.equal(content[0].type,'text');
    assert.match(content[0].text as string,/360-degree/); assert.match(content[0].text as string,/camera fully fixed/);
    assert.deepEqual(content[1],{type:'image_url',image_url:{url:image},role:'first_frame'});
    return Response.json({id});
  });
  assert.deepEqual(await createRotation({image},env),{remoteId:id,model:'doubao-seedance-1-0-pro-250528'});
  assert.equal(fetch.mock.callCount(),1);
});

test('invalid input, missing key and already aborted submit never call upstream', async (t) => {
  const fetch=mockFetch(t,()=>{throw Error('must not call');});
  await assert.rejects(createRotation({image:'bad'},env),ProviderError);
  await assert.rejects(createRotation({image},{}),errorCode('not_configured'));
  await assert.rejects(createRotation({image},{AIYI_VIDEO_KEY:'bad\nkey'}),errorCode('not_configured'));
  await assert.rejects(createRotation({image},env,AbortSignal.abort()),errorCode('cancelled'));
  assert.equal(fetch.mock.callCount(),0);
});

test('network failure on create is uncertain and never causes a paid retry or error leak', async (t) => {
  const fetch=mockFetch(t,()=>{throw Error(`Bearer ${env.AIYI_VIDEO_KEY} https://private.invalid/`);});
  await assert.rejects(createRotation({image},env),errorCode('submission_unknown'));
  assert.equal(fetch.mock.callCount(),1);
});

test('mid-submission abort is uncertain and does not resubmit', async (t) => {
  const controller=new AbortController();
  const fetch=mockFetch(t,request=>new Promise((_resolve,reject)=>{
    request.signal.addEventListener('abort',()=>reject(Error('sensitive upstream error')),{once:true}); controller.abort();
  }));
  await assert.rejects(createRotation({image},env,controller.signal),errorCode('submission_unknown'));
  assert.equal(fetch.mock.callCount(),1);
});

test('create invalid JSON, oversized bodies, lost IDs and redirects remain uncertain', async (t) => {
  const cases=[()=>new Response('not JSON'),()=>Response.json({id:'bad/id'}),()=>Response.json({secret:env.AIYI_VIDEO_KEY}),()=>new Response('x'.repeat(131073)),()=>new Response(null,{status:302,headers:{location:'https://evil.invalid'}}),()=>new Response(`upstream ${env.AIYI_VIDEO_KEY}`,{status:503})];
  let index=0;const fetch=mockFetch(t,()=>cases[index++]());
  for(const _ of cases) await assert.rejects(createRotation({image},env),errorCode('submission_unknown'));
  assert.equal(fetch.mock.callCount(),cases.length);
});

test('explicit rejection classifications are sanitized and never retried', async (t) => {
  const cases: Array<[number,string]>=[[400,'unsupported_request'],[401,'provider_access'],[403,'provider_access'],[404,'unsupported_request'],[422,'unsupported_request'],[429,'provider_limit'],[402,'provider_limit']];
  let index=0;const fetch=mockFetch(t,()=>new Response(`RAW ${env.AIYI_VIDEO_KEY} https://secret.invalid/`,{status:cases[index++][0]}));
  for(const [,code] of cases) await assert.rejects(createRotation({image},env),errorCode(code));
  assert.equal(fetch.mock.callCount(),cases.length);
});

test('queries only GET the original task and normalize official statuses', async (t) => {
  const statuses=['queued','running','succeeded','failed','cancelled','expired'];let index=0;
  const fetch=mockFetch(t,request=>{
    assert.equal(request.method,'GET');assert.equal(request.url,`https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${id}`);
    assert.equal(request.redirect,'manual');assert.equal(request.headers.get('authorization'),`Bearer ${env.AIYI_VIDEO_KEY}`);
    return Response.json({id,status:statuses[index++],content:{video_url:media},error:{message:`Bearer ${env.AIYI_VIDEO_KEY}`}});
  });
  for(const status of statuses){const result=await queryRotation(id,env);assert.equal(result.status,status==='cancelled'?'failed':status);if(status==='succeeded')assert.equal(result.videoUrl,media);else assert.equal(result.videoUrl,undefined);if(result.message)assert.ok(!result.message.includes(env.AIYI_VIDEO_KEY));}
  assert.equal(fetch.mock.callCount(),statuses.length);
});

test('query rejects invalid task IDs before HTTP', async (t) => {
  const fetch=mockFetch(t,()=>{throw Error('must not call');});
  for(const value of ['','../escape','x?token=y','x'.repeat(161)])await assert.rejects(queryRotation(value,env),errorCode('invalid_request'));
  assert.equal(fetch.mock.callCount(),0);
});

test('query rejects mismatched tasks, unknown status, malformed output and unsafe output URL', async(t)=>{
  const results=[{id:'other',status:'queued'},{id,status:'unexpected'},{id,status:'succeeded'},{id,status:'succeeded',content:{video_url:'https://evil.invalid/a.mp4'}},{id,status:'succeeded',content:{video_url:'http://media.volces.com/a.mp4'}}];let index=0;
  const fetch=mockFetch(t,()=>Response.json(results[index++]));
  for(const _ of results)await assert.rejects(queryRotation(id,env),errorCode('invalid_response'));
  assert.equal(fetch.mock.callCount(),results.length);
});

test('query network interruption is recoverable by another GET, never POST',async(t)=>{
  let count=0;const fetch=mockFetch(t,request=>{assert.equal(request.method,'GET');if(!count++)throw Error(`secret ${env.AIYI_VIDEO_KEY}`);return Response.json({id,status:'running'});});
  await assert.rejects(queryRotation(id,env),errorCode('connection'));
  assert.deepEqual(await queryRotation(id,env),{status:'running'});assert.equal(fetch.mock.callCount(),2);
});

test('download accepts bounded MP4 on official CDN and sends neither key nor cookies',async(t)=>{
  const bytes=mp4();const fetch=mockFetch(t,request=>{
    assert.equal(request.url,media);assert.equal(request.redirect,'manual');assert.equal(request.credentials,'omit');
    assert.equal(request.headers.get('authorization'),null);assert.equal(request.headers.get('cookie'),null);
    return new Response(bytes as BodyInit,{headers:{'content-type':'video/mp4'}});
  });
  assert.deepEqual(await downloadRotation(media),new Uint8Array(bytes));assert.equal(fetch.mock.callCount(),1);
});

test('download rejects nonofficial URL, suffix spoofing, private hosts and explicit authority options before HTTP',async(t)=>{
  const fetch=mockFetch(t,()=>{throw Error('must not call');});
  for(const url of ['http://cdn.volces.com/a.mp4','https://volces.com/a.mp4','https://volccdn.com/a.mp4','https://volces.com.evil.invalid/a.mp4','https://evilvolces.com/a.mp4','https://127.0.0.1/a.mp4','https://[::1]/a.mp4','https://localhost/a.mp4','https://user@cdn.volces.com/a.mp4','https://cdn.volces.com:443/a.mp4','https://cdn.volces.com:8443/a.mp4','https://cdn.volces.com/a.mp4#part','https://cdn.volces.com./a.mp4','https://cdn.volces.com/a\n.mp4'])await assert.rejects(downloadRotation(url),errorCode('invalid_response'));
  assert.equal(fetch.mock.callCount(),0);
});

test('download never follows redirects and rejects empty, non-MP4 and oversized declared responses',async(t)=>{
  const cases=[()=>new Response(null,{status:302,headers:{location:'https://evil.invalid'}}),()=>new Response(''),()=>new Response(mp4() as BodyInit,{headers:{'content-type':'text/html'}}),()=>new Response(mp4() as BodyInit,{headers:{'content-length':String(33*1024*1024)}}),()=>new Response(Buffer.alloc(40)),()=>new Response(Uint8Array.from([0,0,0,80,102,116,121,112,105,115,111,109,0,0,0,0]))];let index=0;
  const fetch=mockFetch(t,()=>cases[index++]());
  for(let i=0;i<cases.length;i++)await assert.rejects(downloadRotation(media),errorCode(i===0?'download':'invalid_response'));
  assert.equal(fetch.mock.callCount(),cases.length);
});

test('download enforces streamed size even without content-length',async(t)=>{
  const fetch=mockFetch(t,()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(32*1024*1024));controller.enqueue(new Uint8Array(1));controller.close();}})));
  await assert.rejects(downloadRotation(media),errorCode('video_too_large'));assert.equal(fetch.mock.callCount(),1);
});

test('aborted download never calls CDN and interrupted download exposes no raw errors',async(t)=>{
  const fetch=mockFetch(t,()=>{throw Error(`RAW ${env.AIYI_VIDEO_KEY} https://secret.invalid`);});
  await assert.rejects(downloadRotation(media,AbortSignal.abort()),errorCode('cancelled'));assert.equal(fetch.mock.callCount(),0);
  await assert.rejects(downloadRotation(media),errorCode('download'));assert.equal(fetch.mock.callCount(),1);
});
