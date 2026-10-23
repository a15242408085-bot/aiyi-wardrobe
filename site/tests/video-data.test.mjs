import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const storageSource = readFileSync(new URL('../ui/storage.js', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../ui/api.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const png = 'data:image/png;base64,YQ==';
const item = (id = 'shirt', name = '针织衫') => ({ id, name, category: 'top', color: '米色', notes: '', image: 'seed:shirt', favorite: false, example: true });
const model = (id = 'model') => ({ id, name: '人物', image: 'seed:model', example: true, createdAt: '' });
const seed = { items: [item()], models: [model()], assets: { shirt: png, model: png } };
const empty = () => ({ version: 1, items: [item()], models: [model()], outfits: [], generated: [], lookMeta: {} });
const REQUEST = '12345678-1234-4123-8123-123456789abc', CLIENT = 'b'.repeat(64);
function localStorageFake(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data };
}
function indexedDBFake(initial) {
  const data = new Map(initial === undefined ? [] : [['wardrobe', initial]]);
  const db = { objectStoreNames: { contains: () => true }, close() {}, transaction() {
    const tx = { objectStore: () => ({
      get(key) { const req = {}; queueMicrotask(() => { req.result = data.get(key); req.onsuccess?.(); }); return req; },
      put(value, key) { queueMicrotask(() => { data.set(key, structuredClone(value)); tx.oncomplete?.(); }); },
      delete(key) { queueMicrotask(() => { data.delete(key); tx.oncomplete?.(); }); },
    }) }; return tx;
  } };
  return { data, open() { const req = { result: db }; queueMicrotask(() => req.onsuccess?.()); return req; } };
}
function load({ indexedDB, localStorage = localStorageFake(), fetch, protocol = 'https:' } = {}) {
  const context = vm.createContext({ Blob, structuredClone, TextDecoder, TextEncoder, ReadableStream, Response, Headers, Uint8Array, crypto: webcrypto, console, setTimeout, clearTimeout, indexedDB, localStorage, fetch, location: { protocol } });
  vm.runInContext(storageSource + '\n' + apiSource, context);
  return { storage: context.AiyiStorage, api: context.AiyiAPI, context };
}
function streamResponse(events, split = 17) {
  const bytes = new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += split) controller.enqueue(bytes.slice(offset, offset + split)); controller.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } });
}

test('existing IndexedDB wardrobe and extended OW metadata survive save and reload', async () => {
  const saved = empty(); saved.items[0].customNote = '既有字段';
  saved.ow = { collections: [{ id: 'closet', name: '旅行', itemIds: ['shirt'], coverId: 'shirt' }], layouts: [{ id: 'layout', name: '旅行搭配', pieces: [{ id: 'piece', itemId: 'shirt', x: 25, y: 60, width: 35, rotation: 12, z: 1 }] }], itemMeta: { shirt: { brand: '我的品牌', wears: ['2026-10-21'], extra: { care: '手洗' } } }, plans: [{ id: 'plan', date: '2026-10-22', kind: 'outfit', refId: 'layout', status: 'planned' }], preferences: { height: 165 }, extensionHistory: [{ id: 'extra', note: '保留' }] };
  const db = indexedDBFake(saved), { storage } = load({ indexedDB: db });
  const store = await storage.create(seed); assert.equal(store.mode, 'indexedDB');
  assert.equal(store.state.items[0].customNote, '既有字段');
  assert.equal(store.state.ow.itemMeta.shirt.extra.care, '手洗');
  store.state.videoDemo.favoriteById['example-look'] = true;
  assert.equal(await store.save(), true);
  const restored = await storage.create(seed);
  assert.equal(restored.state.videoDemo.favoriteById['example-look'], true);
  assert.deepEqual(plain(restored.state.ow.extensionHistory), [{ id: 'extra', note: '保留' }]);
});

test('invalid stored data enters memory and never overwrites the original', async () => {
  const original = { version: 1, items: [{ id: '__proto__' }], models: [], outfits: [] }, db = indexedDBFake(original);
  const { storage } = load({ indexedDB: db }); const store = await storage.create(seed);
  assert.equal(store.mode, 'memory'); store.state.items[0].name = '临时修改';
  assert.equal(await store.save(), false); assert.deepEqual(db.data.get('wardrobe'), original);
});

test('localStorage fallback migrates the same legacy key and safely saves', async () => {
  const local = localStorageFake({ 'aiyi-offline-v1': JSON.stringify(empty()) }), { storage } = load({ localStorage: local });
  const store = await storage.create(seed); assert.equal(store.mode, 'localStorage');
  store.state.items[0].name = '保留衣物'; await store.save();
  assert.equal(JSON.parse(local.getItem('aiyi-offline-v1')).items[0].name, '保留衣物');
});

test('malicious IDs, prototype fields, remote images, svg and traversal are rejected', () => {
  const { storage } = load();
  for (const id of ['__proto__', 'constructor', 'bad id', '<script>']) { const raw = empty(); raw.items[0].id = id; assert.throws(() => storage.normalize(raw, seed)); }
  for (const ref of ['https://example.com/photo.jpg', 'javascript:alert(1)', 'data:image/svg+xml;base64,YQ==', '/video-reference/../photo.png', '//video-reference/photo.png', '/video-reference/%2e/photo.png']) { const raw = empty(); raw.items[0].image = ref; assert.throws(() => storage.normalize(raw, seed)); }
  const proto = JSON.parse('{"version":1,"items":[],"models":[],"outfits":[],"ow":{"__proto__":{"polluted":true}}}');
  assert.throws(() => storage.normalize(proto, seed)); assert.equal({}.polluted, undefined);
  const raw = empty(); raw.items[0].image = '/video-reference/garments/shirt-1.webp';
  assert.equal(storage.normalize(raw, seed).items[0].image, raw.items[0].image);
});

test('catalog items and models survive reload while untrusted asset paths are rejected', async () => {
  const db = indexedDBFake(empty()), { storage } = load({ indexedDB: db });
  const store = await storage.create(seed);
  store.state.items.push({ ...item('asset-tops-01'), image: '/wardrobe-assets/tops/tops-01-oatmeal-henley.png' });
  store.state.models.push({ ...model('hq-model-01'), image: '/model-assets/model-01.png' });
  assert.equal(await store.save(), true);
  const restored = await storage.create(seed);
  assert.equal(restored.state.items.find(n => n.id === 'asset-tops-01').image, '/wardrobe-assets/tops/tops-01-oatmeal-henley.png');
  assert.equal(restored.state.models.find(n => n.id === 'hq-model-01').image, '/model-assets/model-01.png');
  for (const image of ['/wardrobe-assets/tops/../secret.png', '/wardrobe-assets/tops/%2e%2e.png', '/wardrobe-assets/tops/foo.svg', '//wardrobe-assets/tops/foo.png', '/model-assets/model-01.png?redirect=https://example.com', 'https://example.com/model-assets/model-01.png']) {
    const raw = empty(); raw.items[0].image = image;
    assert.throws(() => storage.normalize(raw, seed));
  }
});

test('limits reject before replacing stored or merged data', async () => {
  const { storage } = load(); const raw = empty(); raw.items = Array.from({ length: 501 }, (_, i) => item(`shirt-${i}`));
  assert.throws(() => storage.normalize(raw, seed), /数量/);
  const large = empty(); large.ow = { history: Array.from({ length: 14 }, () => 'a'.repeat(4000000)) };
  assert.throws(() => storage.normalize(large, seed), /50 MB/);
  const current = empty(); current.items = Array.from({ length: 500 }, (_, i) => item(`shirt-${i}`));
  assert.throws(() => storage.merge(current, empty(), seed), /数量/); assert.equal(current.items.length, 500);
});

test('conflicting import remaps items, models, generated snapshots and date references', () => {
  const { storage } = load(), current = empty(), incoming = empty();
  current.outfits = [{ id: 'outfit', name: '旧搭配', modelId: 'model', itemIds: ['shirt'] }];
  current.generated = [{ id: 'look', name: '旧试穿', image: png, modelImage: png, modelId: 'model', items: [{ id: 'shirt', name: '针织衫', category: 'top' }] }];
  incoming.items[0].name = '新衬衫'; incoming.models[0].name = '新人物';
  incoming.outfits = [{ id: 'outfit', name: '新搭配', modelId: 'model', itemIds: ['shirt'] }];
  incoming.generated = [{ id: 'look', name: '新试穿', image: png, modelImage: png, modelId: 'model', items: [{ id: 'shirt', name: '新衬衫', category: 'top' }] }];
  incoming.lookMeta = { look: { date: '2026-10-23', favorite: true }, 'model-model': { hidden: true } };
  incoming.videoDemo = { mode: 'personal', favoriteById: { look: true }, dateById: { look: '2026-10-23' }, hiddenLookIds: ['model-model'] };
  incoming.ow = { collections: [{ id: 'closet', name: '新衣橱', itemIds: ['shirt'], coverId: 'shirt' }], layouts: [{ id: 'layout', name: '新平铺', pieces: [{ id: 'p', itemId: 'shirt' }] }], plans: [{ id: 'planned-look', kind: 'look', refId: 'look', date: '2026-10-23' }, { id: 'planned-outfit', kind: 'outfit', refId: 'outfit', date: '2026-10-24' }, { id: 'planned-layout', kind: 'outfit', refId: 'layout', date: '2026-10-25' }], itemMeta: { shirt: { wears: ['2026-10-23'] } } };
  const merged = storage.merge(current, incoming, seed), newItem = merged.items.find(row => row.name === '新衬衫'), newModel = merged.models.find(row => row.name === '新人物'), newOutfit = merged.outfits.find(row => row.name === '新搭配'), newLook = merged.generated.find(row => row.name === '新试穿');
  assert.notEqual(newItem.id, 'shirt'); assert.notEqual(newModel.id, 'model'); assert.notEqual(newLook.id, 'look'); assert.notEqual(newOutfit.id, 'outfit');
  assert.equal(newLook.items[0].id, newItem.id); assert.equal(newLook.modelId, newModel.id);
  assert.equal(newOutfit.modelId, newModel.id); assert.equal(newOutfit.itemIds[0], newItem.id);
  assert.equal(merged.lookMeta[newLook.id].date, '2026-10-23'); assert.equal(merged.lookMeta[`model-${newModel.id}`].hidden, true);
  assert.equal(merged.videoDemo.dateById[newLook.id], '2026-10-23'); assert.equal(merged.videoDemo.hiddenLookIds[0], `model-${newModel.id}`);
  assert.equal(merged.ow.collections[0].itemIds[0], newItem.id); assert.equal(merged.ow.layouts[0].pieces[0].itemId, newItem.id);
  assert.equal(merged.ow.plans.find(row => row.id === 'planned-look').refId, newLook.id);
  assert.equal(merged.ow.plans.find(row => row.id === 'planned-outfit').refId, newOutfit.id);
  assert.equal(merged.ow.itemMeta[newItem.id].wears[0], '2026-10-23'); assert.equal(current.items.length, 1);
});

test('generic local records preserve pending tasks; blobs cannot overwrite wardrobe', async () => {
  const db = indexedDBFake(empty()), { storage } = load({ indexedDB: db }), store = await storage.create(seed);
  const pending = { metadata: { requestId: REQUEST }, context: { image: png } };
  await store.putRecord('ai-pending', pending); assert.deepEqual(plain(await store.getRecord('ai-pending')), pending);
  await store.putBlob('rotation', new Blob(['video'], { type: 'video/mp4' })); assert.equal((await store.getBlob('rotation')).size, 5);
  assert.equal(db.data.get('wardrobe').version, 1); assert.ok(db.data.has('video-blob-rotation'));
  await assert.rejects(store.putRecord('wardrobe', {})); await store.deleteRecord('ai-pending'); assert.equal(await store.getRecord('ai-pending'), undefined);
});

test('unknown OW history is retained during merge and scalar conflicts never overwrite silently', () => {
  const { storage } = load(), current = empty(), incoming = empty();
  current.ow = { extensionHistory: [{ event: '已有记录' }], extensionSettings: { keep: true } };
  incoming.ow = { extensionHistory: [{ event: '导入记录' }], extensionSettings: { added: true } };
  const merged = storage.merge(current, incoming, seed);
  assert.deepEqual(plain(merged.ow.extensionHistory), [{ event: '已有记录' }, { event: '导入记录' }]);
  assert.deepEqual(plain(merged.ow.extensionSettings), { keep: true, added: true });
  incoming.ow.extensionSettings.keep = false;
  assert.throws(() => storage.merge(current, incoming, seed), /扩展资料存在冲突/);
  assert.equal(current.ow.extensionSettings.keep, true);
});

test('legacy rotation blobs can be recovered without moving or deleting old record', async () => {
  const db = indexedDBFake(empty()); db.data.set('rotation', { file: new Blob(['legacy']), lookId: 'example-look' });
  const store = await load({ indexedDB: db }).storage.create(seed);
  assert.equal((await store.getBlob('rotation')).size, 6); assert.ok(db.data.has('rotation'));
});

test('AI client preserves existing browser ID and status uses invitation header without cookies', async () => {
  const local = localStorageFake({ 'aiyi-ai-client-v1': CLIENT }); let called;
  const { api } = load({ localStorage: local, fetch: async (url, options) => { called = { url, options }; return Response.json({ authorized: true, configured: true }); } });
  assert.equal(api.makeClientId(), CLIENT); assert.equal((await api.status({ code: 'test', clientId: CLIENT })).authorized, true);
  assert.equal(called.options.credentials, 'omit'); assert.equal(called.options.headers['X-Aiyi-Code'], 'test'); assert.ok(called.url.includes(CLIENT));
});

test('split NDJSON and UTF-8 chunks complete exactly once with matching task ID', async () => {
  const events = [{ type: 'started', taskId: REQUEST }, { type: 'heartbeat', taskId: REQUEST }, { type: 'completed', taskId: REQUEST, result: { garments: [{ name: '红色针织衫' }] } }], seen = []; let call;
  const { api } = load({ fetch: async (url, options) => { call = { url, options }; return streamResponse(events, 1); } });
  const result = await api.submit('recognition', { image: png, clientId: 'spoof', requestId: 'spoof' }, { code: 'test', clientId: CLIENT, requestId: REQUEST, onEvent: event => seen.push(event.type) });
  assert.equal(result.garments[0].name, '红色针织衫'); assert.deepEqual(seen, ['started', 'heartbeat', 'completed']);
  assert.equal(call.url, '/api/ai/recognize'); assert.equal(JSON.parse(call.options.body).requestId, REQUEST); assert.equal(JSON.parse(call.options.body).clientId, CLIENT);
});

test('disconnect is recoverable and never resubmits a paid request automatically', async () => {
  let calls = 0; const { api } = load({ fetch: async () => { calls++; return streamResponse([{ type: 'started', taskId: REQUEST }]); } });
  await assert.rejects(api.submit('tryOn', {}, { clientId: CLIENT, code: 'test', requestId: REQUEST }), error => error.recoverable === true && error.code === 'disconnected');
  assert.equal(calls, 1);
});

test('mismatched task IDs are recoverable errors in submit and query', async () => {
  const { api } = load({ fetch: async () => streamResponse([{ type: 'completed', taskId: 'different', result: {} }]) });
  await assert.rejects(api.submit('tryOn', {}, { clientId: CLIENT, requestId: REQUEST }), error => error.code === 'task_mismatch' && error.recoverable);
  const queryAPI = load({ fetch: async () => Response.json({ taskId: 'different', status: 'succeeded', result: {} }) }).api;
  await assert.rejects(queryAPI.query(REQUEST, { clientId: CLIENT }), error => error.code === 'task_mismatch');
});

test('server failures retain status/code while unsafe raw error messages stay private', async () => {
  const { api } = load({ fetch: async () => Response.json({ error: 'access', message: 'Bearer sk-thismustnotbeexposed12345' }, { status: 401 }) });
  await assert.rejects(api.status({ clientId: CLIENT, code: 'bad' }), error => error.status === 401 && error.code === 'access' && !error.message.includes('sk-'));
});

test('stream failed events terminate without promising recovery or retrying', async () => {
  const { api } = load({ fetch: async () => streamResponse([{ type: 'failed', taskId: REQUEST, code: 'generation_failed', message: '本次生成未完成。' }]) });
  await assert.rejects(api.submit('tryOn', {}, { clientId: CLIENT, requestId: REQUEST }), error => error.terminal === true && error.recoverable === false && error.code === 'generation_failed');
});

test('single-file offline use never sends requests', async () => {
  let calls = 0; const { api } = load({ protocol: 'file:', fetch: async () => { calls++; } });
  await assert.rejects(api.status({ clientId: CLIENT }), error => error.code === 'offline'); assert.equal(calls, 0);
});
