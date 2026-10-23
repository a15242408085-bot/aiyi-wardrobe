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

function harness({ api: apiOverrides = {}, save = true, records = new Map(), recordSave = () => true } = {}) {
  const body = new Element('body'); body.connect(true);
  const elements = new Map([['seed-data', { textContent: JSON.stringify(seed) }]]);
  const get = id => { if (!elements.has(id)) { const node = new Element(); body.append(node); elements.set(id, node); } return elements.get(id); };
  const resultStage = new Element(), resultPhoto = new Element('img'); body.append(resultStage); resultStage.append(resultPhoto); elements.set('result-photo', resultPhoto);
  const local = memoryStorage(), objectURLs = [], posted = [], queried = [], timers = new Map();let timerId=0;
  const api = {
    makeClientId: () => clientId,
    status: async () => ({ authorized: true, configured: true, rotationConfigured: true, remaining: { recognition: 5, tryOn: 5, rotation: 2 } }),
    submit: async (...args) => { posted.push(args); return { imageDataUrl: png }; },
    query: async (...args) => { queried.push(args); return { status: 'running' }; },
    createRotation: async (payload, options) => { posted.push({payload,options}); return {taskId:options.requestId,status:'queued'}; },
    queryRotation: async (id, options) => { queried.push({id,options}); return {taskId:id,status:'running'}; },
    readRotation: async () => new Blob(['mp4-video'], {type:'video/mp4'}),
    ...apiOverrides,
  };
  const store = {
    state: initial(), mode: 'indexedDB',
    save: typeof save === 'function' ? save : async () => save,
    getRecord: async key => records.get(key),
    putRecord: async (key, value) => { records.set(key, structuredClone(value)); return recordSave(key,value); },
    deleteRecord: async key => { records.delete(key); return true; },
  };
  const document = {
    body, hidden: false,
    getElementById: get, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    Blob, structuredClone, crypto: webcrypto, console, setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;}, clearTimeout:id=>timers.delete(id),
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
      requireAI,submitTask,complete,queryTask,restoreTask,renderVideo,importRotation,openCamera,stopCamera,looks,submitRotation,queryRotationTask,completeRotation,scheduleRotationPoll,stopRotationPoll,rotation,go,
      setStore:value=>{store=value;},
      setup:values=>{if('task' in values)task=values.task;if('context' in values)taskContext=values.context;if('busy' in values)busy=values.busy;if('code' in values)code=values.code;if('page' in values)page=values.page;clientId=${JSON.stringify(clientId)};},
      status:()=>({task,context:taskContext,busy,preparing,page,result,state:S(),cameraStream})
    };
  })();`, context, { filename: 'video-studio-under-test.js' });
  const studio = context.studio;
  studio.setStore(store); studio.setup({ code: 'test-invitation' });
  return { studio, store, context, elements, get, records, local, objectURLs, posted, queried, timers };
}

const rotationContext = () => ({ lookId: 'my-look', modelImage: png, name: '我的转身视频' });
const rotationMetadata = () => ({ ...taskMetadata(), kind: 'rotation', lookId: 'my-look' });

test('rotation saves its recovery record before one paid POST and polls only with GET', async () => {
  let h, submitted = 0;
  h = harness({ api: { createRotation: async (payload, options) => {
    submitted++;
    const pending = h.records.get(pendingKey);
    assert.equal(pending.metadata.requestId, options.requestId);
    assert.equal(pending.context.lookId, 'my-look');
    assert.equal(payload.image, png);
    return { taskId: options.requestId, status: 'queued' };
  } } });
  const first = h.studio.requireAI('rotation', () => h.studio.submitRotation(rotationContext()));
  const second = h.studio.requireAI('rotation', () => h.studio.submitRotation(rotationContext()));
  await Promise.all([first, second]);
  assert.equal(submitted, 1);
  assert.equal(h.studio.status().task.phase, 'queued');
  assert.equal(h.studio.status().page, 'processing');
  assert.equal(h.get('processing-label').textContent, 'Creating your 360°');
  assert.equal([...h.timers.values()].filter(t => t.delay === 9000).length, 1);
  await h.studio.queryTask();
  assert.equal(submitted, 1);
  assert.equal(h.queried.length, 1);
  assert.equal(h.studio.status().task.phase, 'running');
});

test('a possibly accepted POST remains pending and recovery never submits a second generation', async () => {
  let posts = 0;
  const h = harness({ api: { createRotation: async () => {
    posts++; throw Object.assign(Error('网络中断，提交结果暂不明确。'), { recoverable: true });
  } } });
  await h.studio.submitRotation(rotationContext());
  const id = h.studio.status().task.requestId;
  assert.equal(posts, 1);
  assert.equal(h.studio.status().task.phase, 'disconnected');
  assert.equal([...h.timers.values()].filter(t => t.delay === 9000).length, 0);
  assert.ok(h.get('processing-recovery').children.some(n => n.textContent === '查询本次结果'));
  await h.studio.queryTask();
  assert.equal(h.queried[0].id, id);
  assert.equal(posts, 1);
});

test('known rejected rotation requests clear their local lock without retrying', async () => {
  let posts = 0;
  const h = harness({ api: { createRotation: async () => { posts++; throw Object.assign(Error('视频服务未启用'), { recoverable: false }); } } });
  await h.studio.submitRotation(rotationContext());
  assert.equal(posts, 1);
  assert.equal(h.studio.status().task, null);
  assert.equal(h.records.has(pendingKey), false);
  assert.equal(h.studio.status().busy, false);
});

test('an accepted rotation remains recoverable when its completed media cannot be downloaded', async () => {
  const h = harness({ api: {
    createRotation: async (_, options) => ({ taskId: options.requestId, status: 'succeeded', result: { mediaPath: `/api/ai/rotation-media/${options.requestId}` } }),
    readRotation: async () => { throw Object.assign(Error('下载暂时被拒绝，请稍后查询。'), { status: 403, recoverable: false }); },
  } });
  await h.studio.submitRotation(rotationContext());
  assert.equal(h.studio.status().task.phase, 'disconnected');
  assert.equal(h.records.has(pendingKey), true);
  assert.equal(h.studio.status().busy, false);
  assert.ok(h.get('processing-recovery').children.some(n => n.textContent === '查询本次结果'));
});

test('rotation never sends a paid POST without a persistent recovery record', async () => {
  const h = harness({ recordSave: () => false });
  await h.studio.submitRotation(rotationContext());
  assert.equal(h.posted.length, 0);
  assert.equal(h.studio.status().task, null);
  assert.match(h.get('toast').textContent, /尚未提交/);
});

test('successful video recovery uses the original identity and saves on the original look', async () => {
  const originalClient = 'a'.repeat(64), records = new Map([[pendingKey, { metadata: { ...rotationMetadata(), clientId: originalClient }, context: rotationContext() }]]);
  const downloads = [];
  const h = harness({ records, api: {
    queryRotation: async (id, options) => { downloads.push({ id, options }); return { taskId: id, status: 'succeeded', result: { mediaPath: `/api/ai/rotation-media/${id}` } }; },
    readRotation: async (path, options) => { downloads.push({ path, options }); return new Blob(['recovered-video'], { type: 'video/mp4' }); },
  } });
  await h.studio.restoreTask();
  assert.equal(h.posted.length, 0);
  assert.equal(h.queried.length, 0, 'refresh alone must not launch a request');
  await h.studio.queryTask();
  assert.equal(downloads[0].id, requestId);
  assert.equal(downloads[0].options.clientId, originalClient);
  assert.equal(downloads[1].options.clientId, originalClient);
  assert.equal(await h.records.get('video-rotation-my-look').text(), 'recovered-video');
  assert.equal(h.records.has(pendingKey), false);
  assert.equal(h.studio.status().task, null);
  assert.equal(h.studio.status().page, 'home');
  assert.equal(h.posted.length, 0);
});

test('video persistence failure keeps the finished task recoverable without regenerating', async () => {
  const h = harness({ recordSave: key => !key.startsWith('video-rotation-') });
  h.studio.setup({ task: rotationMetadata(), context: rotationContext(), page: 'processing' });
  await h.studio.completeRotation({ mediaPath: `/api/ai/rotation-media/${requestId}` });
  assert.equal(h.studio.status().task.phase, 'ready');
  assert.equal(h.records.get(pendingKey).metadata.requestId, requestId);
  assert.equal(h.records.get('video-rotation-my-look').type, 'video/mp4');
  assert.equal(h.studio.status().page, 'home');
  assert.equal(h.posted.length, 0);
  assert.equal([...h.timers.values()].filter(t => t.delay === 9000).length, 0);
});

test('rotation polling pauses when minimized or hidden and query failures retain controls', async () => {
  const h = harness({ api: { queryRotation: async () => { throw Error('查询暂时中断'); } } });
  h.studio.setup({ task: { ...rotationMetadata(), phase: 'running' }, context: rotationContext(), page: 'processing' });
  h.studio.scheduleRotationPoll();
  assert.equal([...h.timers.values()].filter(t => t.delay === 9000).length, 1);
  h.studio.go('home');
  assert.equal([...h.timers.values()].filter(t => t.delay === 9000).length, 0);
  h.studio.setup({ page: 'processing' }); h.context.document.hidden = true;
  h.studio.scheduleRotationPoll();
  assert.equal([...h.timers.values()].filter(t => t.delay === 9000).length, 0);
  h.context.document.hidden = false;
  await h.studio.queryTask();
  assert.equal(h.studio.status().task.phase, 'disconnected');
  assert.ok(h.get('processing-recovery').children.some(n => n.textContent === '查询本次结果'));
  assert.equal(h.posted.length, 0);
});

test('rotation has its own service configuration and quota gate', async () => {
  let starts = 0;
  const h = harness({ api: { status: async () => ({ authorized: true, configured: false, rotationConfigured: true, quota: { remaining: { rotation: 1 } } }) } });
  await h.studio.requireAI('rotation', async () => { starts++; });
  assert.equal(starts, 1, 'video-only configuration may start a rotation task');
  h.context.AiyiAPI.status = async () => ({ authorized: true, configured: true, rotationConfigured: false, remaining: { rotation: 1 } });
  await h.studio.requireAI('rotation', async () => { starts++; });
  assert.equal(starts, 1);
});

test('an unknown upstream submission retains the job and waits for explicit attention', async () => {
  const h = harness({ api: { createRotation: async (_, options) => ({ taskId: options.requestId, status: 'running', needsAttention: true, message: '提交结果不明，请稍后手动查询，勿重复生成。' }) } });
  await h.studio.submitRotation(rotationContext());
  assert.equal(h.studio.status().task.phase, 'attention');
  assert.equal(h.records.has(pendingKey), true);
  assert.equal([...h.timers.values()].filter(t => t.delay === 9000).length, 0);
  assert.ok(h.get('processing-recovery').children.some(n => n.textContent === '查询本次结果'));
});

