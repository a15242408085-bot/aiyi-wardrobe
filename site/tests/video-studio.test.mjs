import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../ui/studio.js', import.meta.url), 'utf8');
const storageSource = readFileSync(new URL('../ui/storage.js', import.meta.url), 'utf8');
const seam = source.indexOf('/*__STUDIO_INIT__*/');
assert.ok(seam > 0, 'The studio test seam must remain before automatic initialization');
const png = 'data:image/png;base64,YQ==';
const requestId = '12345678-1234-4123-8123-123456789abc';
const clientId = 'b'.repeat(64);
const pendingKey = 'aiyi-video-ai-pending-v1';
const seed = { assets: {}, items: [], models: [], reference: { items: [], looks: [] } };
const initial = () => ({
  version: 1, items: [], models: [], outfits: [], generated: [], lookMeta: {},
  videoDemo: { mode: 'personal', favoriteById: {}, dateById: {}, hiddenLookIds: [] },
});
const taskMetadata = () => ({ requestId, clientId, kind: 'tryOn', phase: 'disconnected', startedAt: Date.parse('2026-10-23T01:00:00Z') });
const taskContext = () => ({ modelImage: png, modelId: 'person', modelName: '我的照片', items: [{ id: 'shirt', name: '我的衬衫', category: 'top' }], name: '我的搭配' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const plain = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.handlers = new Map();
    this.dataset = {}; this.style = { setProperty() {} }; this.value = ''; this.textContent = '';
    this.classList = { toggle() {}, add() {}, remove() {} }; this.paused = true; this.hidden = false;
    this.parentElement = null; this.isConnected = false;
  }
  connect(value) { this.isConnected = value; for (const child of this.children) if (child instanceof Element) child.connect(value); }
  append(...children) {
    for (const child of children) {
      if (child instanceof Element) {
        if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(node => node !== child);
        child.parentElement = this; child.connect(this.isConnected);
      }
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) if (child instanceof Element) { child.parentElement = null; child.connect(false); }
    this.children = []; this.append(...children);
  }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, handler) { this.handlers.set(name, [...(this.handlers.get(name) || []), handler]); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  pause() { this.paused = true; }
  async play() { this.paused = false; }
  load() {}
  getBoundingClientRect() { return { width: 300, height: 400, top: 0, left: 0 }; }
}

function memoryStorage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}

function harness({ api: apiOverrides = {}, save = true, records = new Map() } = {}) {
  const body = new Element('body'); body.connect(true);
  const elements = new Map([['seed-data', { textContent: JSON.stringify(seed) }]]);
  const get = id => { if (!elements.has(id)) { const node = new Element(); body.append(node); elements.set(id, node); } return elements.get(id); };
  const resultStage = new Element(), resultPhoto = new Element('img'); body.append(resultStage); resultStage.append(resultPhoto); elements.set('result-photo', resultPhoto);
  const local = memoryStorage(), objectURLs = [], posted = [], queried = [];
  const api = {
    makeClientId: () => clientId,
    status: async () => ({ authorized: true, configured: true, remaining: { recognition: 5, tryOn: 5 } }),
    submit: async (...args) => { posted.push(args); return { imageDataUrl: png }; },
    query: async (...args) => { queried.push(args); return { status: 'running' }; },
    ...apiOverrides,
  };
  const store = {
    state: initial(), mode: 'indexedDB',
    save: typeof save === 'function' ? save : async () => save,
    getRecord: async key => records.get(key),
    putRecord: async (key, value) => { records.set(key, structuredClone(value)); return true; },
    deleteRecord: async key => { records.delete(key); return true; },
  };
  const document = {
    body, hidden: false,
    getElementById: get, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    Blob, structuredClone, crypto: webcrypto, console, setTimeout, clearTimeout,
    document, location: { protocol: 'https:', hash: '' }, history: { replaceState() {} },
    matchMedia: () => ({ matches: true }), requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    URL: { createObjectURL: blob => { const url = `blob:test-${objectURLs.length + 1}`; objectURLs.push({ blob, url }); return url; }, revokeObjectURL() {} },
    localStorage: local, sessionStorage: memoryStorage(), AiyiAPI: api,
  });
  context.window = { scrollTo() {} };
  // Run the shipped functions; only image decoding and platform APIs are mocked.
  vm.runInContext(storageSource, context);
  vm.runInContext(`${source.slice(0, seam)}
    compress=async value=>value;
    globalThis.studio={
      requireAI,submitTask,complete,queryTask,restoreTask,renderVideo,importRotation,openCamera,stopCamera,looks,
      setStore:value=>{store=value;},
      setup:values=>{if('task' in values)task=values.task;if('context' in values)taskContext=values.context;if('busy' in values)busy=values.busy;if('code' in values)code=values.code;if('page' in values)page=values.page;clientId=${JSON.stringify(clientId)};},
      status:()=>({task,context:taskContext,busy,preparing,page,result,state:S(),cameraStream})
    };
  })();`, context, { filename: 'video-studio-under-test.js' });
  const studio = context.studio;
  studio.setStore(store); studio.setup({ code: 'test-invitation' });
  return { studio, store, context, elements, get, records, local, objectURLs, posted, queried };
}

test('rapid AI clicks hold one preparation lock and submit one paid request', async () => {
  const status = deferred(), submitted = deferred(); let checks = 0, calls = 0;
  const h = harness({ api: {
    status: () => { checks++; return status.promise; },
    submit: () => { calls++; return submitted.promise; },
  } });
  const next = () => h.studio.submitTask('tryOn', { modelImage: png }, taskContext());
  const first = h.studio.requireAI('tryOn', next);
  const second = h.studio.requireAI('tryOn', next);
  assert.equal(h.studio.status().preparing, true);
  assert.equal(checks, 1);
  status.resolve({ authorized: true, configured: true, remaining: { tryOn: 2 } });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(calls, 1);
  submitted.resolve({ imageDataUrl: png });
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(h.studio.status().preparing, false);
  assert.equal(h.store.state.generated.length, 1);
});

test('direct repeated submit cannot replace an existing task or send another request', async () => {
  const output = deferred(); let calls = 0;
  const h = harness({ api: { submit: () => { calls++; return output.promise; } } });
  const first = h.studio.submitTask('tryOn', {}, taskContext());
  const id = h.studio.status().task.requestId;
  await assert.rejects(h.studio.submitTask('tryOn', {}, { ...taskContext(), modelId: 'different-person' }), /已有任务/);
  assert.equal(h.studio.status().task.requestId, id);
  assert.equal(h.studio.status().context.modelId, 'person');
  output.resolve({ imageDataUrl: png }); await first;
  assert.equal(calls, 1);
});

test('known terminal rejections clear the pending lock and permit a deliberate new attempt', async () => {
  for (const flags of [{ terminal: true }, { recoverable: false }]) {
    let calls = 0;
    const h = harness({ api: { submit: async () => {
      if (++calls === 1) throw Object.assign(Error('这次请求已被明确拒绝。'), flags);
      return { imageDataUrl: png };
    } } });
    await h.studio.submitTask('tryOn', {}, taskContext());
    assert.equal(calls, 1, 'a terminal rejection must never retry automatically');
    assert.equal(h.studio.status().task, null);
    assert.equal(h.studio.status().busy, false);
    assert.equal(h.records.has(pendingKey), false);
    assert.equal(h.local.getItem(pendingKey), null);
    assert.equal(h.store.state.generated.length, 0);
    await h.studio.submitTask('tryOn', {}, taskContext());
    assert.equal(calls, 2, 'a later explicit attempt is no longer blocked by a dead task');
    assert.equal(h.store.state.generated.length, 1);
  }
});

test('failed persistence retains a completed task and a later query saves it without duplicate generation', async () => {
  let writesWork = false;
  const h = harness({ save: async () => writesWork, api: { query: async () => ({ status: 'succeeded', result: { imageDataUrl: png } }) } });
  h.studio.setup({ task: taskMetadata(), context: taskContext() });
  await h.studio.complete({ imageDataUrl: png });
  assert.equal(h.studio.status().task.requestId, requestId);
  assert.equal(h.studio.status().task.phase, 'ready');
  assert.equal(h.records.get(pendingKey).metadata.requestId, requestId);
  assert.equal(h.store.state.generated.length, 1);
  assert.equal(h.studio.status().page, 'result', 'the temporary image remains available for export');
  writesWork = true;
  await h.studio.queryTask();
  assert.equal(h.store.state.generated.length, 1, 'recovery updates the same task, without duplicating the look');
  assert.equal(h.studio.status().task, null);
  assert.equal(h.records.has(pendingKey), false);
  assert.equal(h.posted.length, 0, 'query recovery must not call the paid submission endpoint');
});

test('a failed task query leaves retry controls visible and never resubmits', async () => {
  const h = harness({ api: { query: async () => { throw Error('网络暂时中断'); } } });
  h.studio.setup({ task: taskMetadata(), context: taskContext(), page: 'processing' });
  await h.studio.queryTask();
  assert.equal(h.studio.status().busy, false);
  assert.equal(h.studio.status().task.requestId, requestId);
  assert.equal(h.studio.status().page, 'processing');
  const controls = h.get('processing-recovery').children;
  assert.ok(controls.some(node => node.textContent === '查询本次结果'));
  assert.ok(controls.some(node => node.textContent === '移除本机任务记录'));
  assert.equal(h.posted.length, 0);
});

test('legacy pending task recovery queries the original browser identity without a new submission', async () => {
  const originalClient = 'a'.repeat(64), metadata = { ...taskMetadata(), clientId: originalClient };
  const records = new Map([['ai-pending', { metadata, context: taskContext() }]]), queries = [];
  const h = harness({ records, api: { query: async (id, options) => { queries.push({ id, options }); return { status: 'running' }; } } });
  await h.studio.restoreTask();
  assert.equal(h.studio.status().task.requestId, requestId);
  assert.equal(h.studio.status().busy, false);
  assert.equal(h.posted.length, 0);
  await h.studio.queryTask();
  assert.deepEqual(plain(queries), [{ id: requestId, options: { clientId: originalClient, code: 'test-invitation' } }]);
  assert.equal(h.records.has('ai-pending'), true, 'a running legacy task must remain recoverable');
});

test('a local rotation uses storage-valid keys and reloads the imported video', async () => {
  const h = harness();
  const store = await h.context.AiyiStorage.create(seed);
  h.studio.setStore(store);
  const file = new Blob(['local-video'], { type: 'video/mp4' });
  Object.defineProperty(file, 'name', { value: 'turn.mp4' });
  await h.studio.importRotation(file, 'personal-look');
  const stored = await store.getRecord('video-rotation-personal-look');
  assert.equal(stored.type, 'video/mp4');
  assert.equal(await stored.text(), 'local-video');
  await h.studio.renderVideo({ id: 'personal-look' });
  assert.equal(h.get('look-video').src, 'blob:test-1');
  assert.equal(h.get('look-video').hidden, false);
  assert.equal(h.get('look-poster').hidden, true);
  assert.equal(h.objectURLs.length, 1);
  assert.equal(await h.objectURLs[0].blob.text(), 'local-video');
});

test('closing and reopening the camera stops late permission streams and the current stream', async () => {
  const firstPermission = deferred(), secondPermission = deferred(), stops = { first: 0, second: 0 };
  const stream = name => ({ getTracks: () => [{ stop: () => stops[name]++ }] });
  const firstStream = stream('first'), secondStream = stream('second'); let requests = 0;
  const h = harness();
  h.context.navigator = { mediaDevices: { getUserMedia: () => (++requests === 1 ? firstPermission : secondPermission).promise } };
  const firstOpen = h.studio.openCamera();
  h.get('recognition-dialog').close(); h.studio.stopCamera();
  const secondOpen = h.studio.openCamera();
  secondPermission.resolve(secondStream); await secondOpen;
  assert.equal(h.studio.status().cameraStream, secondStream);
  firstPermission.resolve(firstStream); await firstOpen;
  assert.equal(stops.first, 1, 'the late stream must be stopped instead of replacing the current camera');
  assert.equal(h.studio.status().cameraStream, secondStream);
  h.get('recognition-dialog').close(); h.studio.stopCamera();
  assert.equal(stops.second, 1);
  assert.equal(h.studio.status().cameraStream, null);
});

test('legacy look metadata keeps hidden looks hidden and preserves dates and favorites', () => {
  const h = harness(), base = { name: '既有搭配', image: png, items: [{ id: 'shirt', name: '衬衫', category: 'top' }], createdAt: '2026-10-23T00:00:00Z' };
  h.store.state.generated = [{ ...base, id: 'hidden-look' }, { ...base, id: 'favorite-look' }];
  h.store.state.lookMeta = { 'hidden-look': { hidden: true }, 'favorite-look': { favorite: true, date: '2026-09-10' } };
  const looks = h.studio.looks();
  assert.equal(looks.length, 1);
  assert.equal(looks[0].id, 'favorite-look');
  assert.equal(looks[0].date, '2026-09-10');
  assert.equal(looks[0].favorite, true);
  h.store.state.videoDemo.favoriteById['favorite-look'] = false;
  h.store.state.videoDemo.dateById['favorite-look'] = '2026-10-20';
  assert.equal(h.studio.looks()[0].favorite, false, 'new explicit changes override the legacy fallback');
  assert.equal(h.studio.looks()[0].date, '2026-10-20');
});
