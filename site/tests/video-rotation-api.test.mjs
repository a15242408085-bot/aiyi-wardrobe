import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../ui/api.js', import.meta.url), 'utf8');
const id = '12345678-1234-4123-8123-123456789abc';
const options = { requestId: id, clientId: 'c'.repeat(64), code: 'invitation' };
const mediaPath = `/api/ai/rotation-media/${id}`;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function api(fetch, protocol = 'https:') {
  const context = vm.createContext({ fetch, location: { protocol }, crypto: webcrypto, TextDecoder, Uint8Array, Blob, localStorage: { getItem: () => null, setItem() {} } });
  vm.runInContext(source, context);
  return context.AiyiAPI;
}

test('rotation creation sends one same-origin JSON POST with invitation headers', async () => {
  const requests = [], client = api(async (path, init) => { requests.push({ path, init }); return json({ taskId: id, status: 'queued' }); });
  const task = await client.createRotation({ image: 'data:image/png;base64,YQ==', ignored: 'omit' }, options);
  assert.equal(task.status, 'queued');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/ai/rotation');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.headers['X-Aiyi-Code'], 'invitation');
  assert.deepEqual(JSON.parse(requests[0].init.body), { image: 'data:image/png;base64,YQ==', requestId: id, clientId: options.clientId });
});

test('approved portrait submits only its logical source ID and keeps the same task identity', async () => {
  const requests = [], client = api(async (path, init) => { requests.push({ path, init }); return json({ taskId: id, status: 'queued' }); });
  await client.createRotation({ sourceId: 'hq-model-03', ignored: 'omit' }, options);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/ai/rotation');
  assert.deepEqual(JSON.parse(requests[0].init.body), { sourceId: 'hq-model-03', requestId: id, clientId: options.clientId });
});

test('invalid portrait IDs and ambiguous image/source inputs never reach the API', async () => {
  let requests = 0;
  const client = api(async () => { requests++; throw Error('must not fetch'); });
  const image = 'data:image/png;base64,YQ==';
  for (const sourceId of ['asset://approved-portrait', '/model-assets/model-01.png', image, 'https://other.example/portrait.png', 'hq-model-07', 'hq-model-01\n', '', null]) {
    await assert.rejects(client.createRotation({ sourceId }, options), error => error.code === 'input' && error.recoverable === false);
  }
  for (const payload of [{}, [], { sourceId: 'hq-model-01', image }, { sourceId: 'hq-model-01', image: undefined }, { sourceId: undefined, image }]) {
    await assert.rejects(client.createRotation(payload, options), error => error.code === 'input' && error.recoverable === false);
  }
  assert.equal(requests, 0);
});

test('rotation network or server failures are recoverable and never retry POST', async () => {
  for (const request of [async () => { throw Error('offline'); }, async () => json({ message: '暂时中断' }, 503)]) {
    let calls = 0;
    const client = api(async (...args) => { calls++; return request(...args); });
    await assert.rejects(client.createRotation({ image: 'data:image/png;base64,YQ==' }, options), error => error.recoverable === true);
    assert.equal(calls, 1);
  }
});

test('query validates the original task and never accepts a remote media URL', async () => {
  const requests = [];
  const client = api(async (path, init) => { requests.push({ path, init }); return json({ taskId: id, status: 'succeeded', result: { mediaPath: 'https://other.example/video.mp4' } }); });
  await assert.rejects(client.queryRotation(id, options), /结果地址无效/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, `/api/ai/rotation-tasks/${id}?clientId=${options.clientId}`);
  assert.equal(requests[0].init.method, undefined);
  assert.equal(requests[0].init.headers['X-Aiyi-Code'], options.code);
  const mismatch = api(async () => json({ taskId: '22345678-1234-4123-8123-123456789abc', status: 'running' }));
  await assert.rejects(mismatch.queryRotation(id, options), /任务编号不一致/);
});

test('authenticated media download produces a local MP4 Blob from one same-origin request', async () => {
  const requests = [];
  const client = api(async (path, init) => { requests.push({ path, init }); return new Response(new Uint8Array([0, 1, 2, 3]), { headers: { 'content-type': 'video/mp4', 'content-length': '4' } }); });
  const blob = await client.readRotation(mediaPath, options);
  assert.equal(blob.type, 'video/mp4');
  assert.equal(blob.size, 4);
  assert.equal(requests[0].path, `${mediaPath}?clientId=${options.clientId}`);
  assert.equal(requests[0].init.headers['X-Aiyi-Code'], options.code);
  assert.equal(requests[0].init.credentials, 'omit');
});

test('invalid, external, or traversal media paths are rejected before a network call', async () => {
  let requests = 0;
  const client = api(async () => { requests++; throw Error('must not fetch'); });
  for (const path of ['https://other.example/video.mp4', `//other.example/${id}`, `/api/ai/rotation-media/../${id}`, `${mediaPath}?other=true`, `${mediaPath}/extra`]) await assert.rejects(client.readRotation(path, options));
  assert.equal(requests, 0);
});

test('media size, type, and empty responses are bounded before video persistence', async () => {
  const responses = [
    () => new Response('oversized', { headers: { 'content-type': 'video/mp4', 'content-length': String(32 * 1024 * 1024 + 1) } }),
    () => new Response('html', { headers: { 'content-type': 'text/html' } }),
    () => new Response(new Uint8Array(), { headers: { 'content-type': 'video/mp4' } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } }), { headers: { 'content-type': 'video/mp4' } }),
  ];
  for (const response of responses) {
    const client = api(async () => response());
    await assert.rejects(client.readRotation(mediaPath, options), error => error.recoverable === true);
  }
});

test('offline copies do not upload images or query/download rotation tasks', async () => {
  let requests = 0;
  const client = api(async () => { requests++; }, 'file:');
  await assert.rejects(client.createRotation({ image: 'data:image/png;base64,YQ==' }, options), /单文件/);
  await assert.rejects(client.queryRotation(id, options), /单文件/);
  await assert.rejects(client.readRotation(mediaPath, options), /单文件/);
  assert.equal(requests, 0);
});
