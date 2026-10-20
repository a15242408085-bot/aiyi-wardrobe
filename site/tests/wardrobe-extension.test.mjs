import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const extensionSource = readFileSync(new URL('../ui/openwardrobe.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const item = (id = 'shirt', name = '针织衫') => ({ id, name, category: 'top', color: '米色', notes: '', image: 'seed:shirt', favorite: false, example: true });
const model = () => ({ id: 'model', name: '人物', image: 'seed:model', example: true, createdAt: '' });
const emptyState = (items = [item()]) => ({ version: 1, items, models: [model()], outfits: [], generated: [], lookMeta: {} });
const seed = { items: [item()], models: [model()], assets: { shirt: 'data:image/png;base64,YQ==', model: 'data:image/png;base64,YQ==' }, example: { modelId: 'model', itemIds: ['shirt'], result: 'seed:shirt' } };

// These tests execute the shipped functions. Only DOM/storage side effects are replaced;
// persistence validation, backup remapping, and pointer event handlers remain real.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.handlers = new Map();
    this.dataset = {}; this.style = {}; this.value = ''; this.textContent = '';
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, handler) { this.handlers.set(name, [...(this.handlers.get(name) || []), handler]); }
  setPointerCapture() {}
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  checkValidity() { return true; }
  reportValidity() { return true; }
  getBoundingClientRect() { return { width: 300, height: 400 }; }
  querySelectorAll() { return this.children; }
  async fire(name, overrides = {}) {
    for (const handler of this.handlers.get(name) || []) {
      await handler({ target: this, preventDefault() {}, stopPropagation() {}, ...overrides });
    }
  }
}
const descendants = root => [root, ...root.children.flatMap(child => child instanceof Element ? descendants(child) : [])];

function harness(initial = emptyState()) {
  const body = new Element('body');
  const elements = new Map([['aiyi-seed', { textContent: JSON.stringify(seed) }]]);
  let id = 0;
  const context = vm.createContext({
    Blob, structuredClone, console, setTimeout, clearTimeout,
    location: { protocol: 'file:' }, crypto: { randomUUID: () => `test-${++id}` },
    document: {
      body,
      createElement: tag => new Element(tag),
      getElementById: name => elements.get(name) || descendants(body).find(node => node.id === name) || null,
    },
  });
  const prefix = appSource.slice(0, appSource.indexOf('/*__WARDROBE_EXTENSION__*/'));
  assert.ok(prefix.endsWith('\n  '), 'Extension marker must remain inside the app closure');
  vm.runInContext(`${prefix}${extensionSource}
    persist=async()=>true;renderAll=()=>{};owRenderAll=()=>{};toast=()=>{};
    globalThis.api={
      sanitize,owSanitize,owMergeBackup,owRecordWear,owMeta,owSetMeta,owAddPlan,
      importBackup,owRenderCanvas,owOpenItem,owEditCollection,owUI,
      state:()=>state,setState:value=>{state=value;owInitialize();},
      metadataPrototype:()=>Object.getPrototypeOf(state.ow.itemMeta)
    };
  })();`, context, { filename: 'wardrobe-extension-under-test.js' });
  const api = context.api;
  api.setState(structuredClone(initial));
  return { api, body, elements };
}

const piece = (overrides = {}) => ({ id: 'piece', itemId: 'shirt', x: 29, y: 42, width: 37, rotation: -17, z: 3, ...overrides });
const layout = (id = 'layout') => ({ id, name: `搭配 ${id}`, note: '周末看展', favorite: true, createdAt: '2026-10-20T12:00:00Z', updatedAt: '2026-10-21T12:00:00Z', pieces: [piece()] });

function backupFile(value) { const source = JSON.stringify(value); return { size: Buffer.byteLength(source), text: async () => source }; }

test('merging an old backup preserves current brand and unions wear dates', () => {
  const { api } = harness();
  const current = api.state();
  current.ow.itemMeta.shirt = { ...api.owMeta('shirt'), brand: '新的品牌', wears: ['2026-10-20', '2026-10-21'] };
  const incoming = { ow: api.owSanitize({ itemMeta: { shirt: { brand: '旧品牌', size: 'M', wears: ['2026-10-19', '2026-10-20'] } } }, current.items), lookMeta: {} };
  api.owMergeBackup(current, incoming, new Map([['shirt', 'shirt']]));
  assert.equal(current.ow.itemMeta.shirt.brand, '新的品牌');
  assert.equal(current.ow.itemMeta.shirt.size, 'M', 'incoming metadata can fill an empty current field');
  assert.deepEqual(plain(current.ow.itemMeta.shirt.wears), ['2026-10-19', '2026-10-20', '2026-10-21']);
});

for (const [key, limit, make] of [
  ['collections', 40, index => ({ id: `c-${index}`, name: `衣橱 ${index}`, itemIds: ['shirt'] })],
  ['layouts', 100, index => layout(`l-${index}`)],
  ['plans', 1000, index => ({ id: `p-${index}`, date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10), kind: 'item', refId: 'shirt', status: 'planned' })],
]) {
  test(`over-capacity ${key} backup is rejected without replacing current state`, async () => {
    const { api } = harness();
    const current = api.state();
    current.ow[key] = Array.from({ length: limit }, (_, index) => make(index));
    const before = JSON.stringify(current);
    const incoming = emptyState();
    incoming.ow = { [key]: [make(limit)] };
    await assert.rejects(api.importBackup(backupFile(incoming)), /超出本机容量/);
    assert.equal(api.state(), current, 'failed import must retain the current state object');
    assert.equal(JSON.stringify(api.state()), before, 'failed import must leave all current rows intact');
    assert.throws(() => api.owSanitize({ [key]: Array.from({ length: limit + 1 }, (_, index) => make(index)) }, current.items), /超出本机容量/);
  });
}

test('reserved item IDs read defaults and record wear without changing object prototypes', () => {
  const { api } = harness(emptyState([item('__proto__'), item('constructor'), item('toString')]));
  const prototype = api.metadataPrototype();
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(plain(api.owMeta(id).wears), []);
    api.owRecordWear([id], '2026-10-21');
    api.owRecordWear([id], '2026-10-21');
    assert.deepEqual(plain(api.owMeta(id).wears), ['2026-10-21']);
    assert.equal(Object.hasOwn(api.state().ow.itemMeta, id), true);
    assert.equal(api.metadataPrototype(), prototype);
  }
  const restored = api.sanitize(JSON.parse(JSON.stringify(api.state())));
  assert.deepEqual(plain(restored.ow.itemMeta.__proto__.wears), ['2026-10-21']);
  assert.equal({}.wears, undefined, 'global Object.prototype must remain unchanged');
});

for (const lifted of [1, 2]) {
  test(`pinch then lift pointer ${lifted} continues a 1px drag without jumping`, async () => {
    const { api, elements } = harness();
    const canvas = new Element(); elements.set('ow-canvas', canvas);
    api.owUI.editor = { name: '手势测试', pieces: [piece({ x: 50, y: 50, width: 30 })] };
    api.owRenderCanvas();
    const node = canvas.children[0];
    await node.fire('pointerdown', { pointerId: 1, clientX: 150, clientY: 200 });
    await node.fire('pointerdown', { pointerId: 2, clientX: 250, clientY: 200 });
    await node.fire('pointermove', { pointerId: 2, clientX: 300, clientY: 200 });
    assert.equal(api.owUI.editor.pieces[0].width, 45);
    await node.fire('pointerup', { pointerId: lifted, clientX: lifted === 1 ? 150 : 300, clientY: 200 });
    const remaining = lifted === 1 ? 2 : 1;
    const start = remaining === 1 ? 150 : 300;
    const before = api.owUI.editor.pieces[0].x;
    await node.fire('pointermove', { pointerId: remaining, clientX: start + 1, clientY: 200 });
    assert.ok(Math.abs(api.owUI.editor.pieces[0].x - before - 1 / 3) < 1e-8);
    assert.equal(api.owUI.editor.pieces[0].width, 45, 'remaining finger must not reset scale');
    await node.fire('pointerup', { pointerId: remaining, clientX: start + 1, clientY: 200 });
  });
}

test('valid collections, layouts, metadata, plans and preferences survive backup roundtrip', async () => {
  const source = emptyState();
  source.ow = {
    collections: [{ id: 'capsule', name: '通勤胶囊', note: '轻松上班', coverId: 'shirt', itemIds: ['shirt'], createdAt: '2026-10-20T12:00:00Z' }],
    layouts: [layout()],
    itemMeta: { shirt: { brand: '品牌', size: 'M', material: '棉', season: '春秋', occasion: '日常通勤', price: 299.5, purchasedAt: '2026-09-10', wears: ['2026-10-20', '2026-10-21'], archived: false } },
    plans: [{ id: 'plan', date: '2026-10-22', kind: 'outfit', refId: 'layout', status: 'planned', note: '去看展' }],
    preferences: { occasion: '约会聚餐', style: '宽松自然', height: 165, weight: 52, bust: 85, waist: 67, hip: 91 },
  };
  const { api } = harness(source);
  const expected = plain(api.state());
  const roundtrip = plain(api.sanitize(JSON.parse(JSON.stringify(api.state()))));
  assert.deepEqual(roundtrip, expected);
  const destination = harness(emptyState([])).api;
  await destination.importBackup(backupFile(api.state()));
  assert.deepEqual(plain(destination.state().ow.collections), expected.ow.collections);
  assert.deepEqual(plain(destination.state().ow.itemMeta), expected.ow.itemMeta);
  assert.deepEqual(plain(destination.state().ow.preferences), expected.ow.preferences);
  const savedLayout = destination.state().ow.layouts[0];
  assert.deepEqual(plain({ ...savedLayout.pieces[0], id: 'piece' }), expected.ow.layouts[0].pieces[0]);
  assert.equal(destination.state().ow.plans[0].refId, savedLayout.id);
  assert.equal(destination.state().ow.plans[0].date, '2026-10-22');
});

test('saving an already-open item detail preserves wear recorded after it was opened', async () => {
  const { api, body } = harness();
  api.owOpenItem('shirt');
  api.owRecordWear(['shirt'], '2026-10-21');
  const save = descendants(body).find(node => node.tagName === 'BUTTON' && node.textContent === '保存资料');
  assert.ok(save, 'item detail must offer a save action');
  await save.fire('click');
  assert.deepEqual(plain(api.owMeta('shirt').wears), ['2026-10-21']);
});

test('imported generated look remaps colliding item and model IDs to imported assets', async () => {
  const { api } = harness();
  const incoming = emptyState([item('shirt', '另一件同 ID 衣服')]);
  incoming.models[0] = { ...model(), name: '另一位同 ID 人物' };
  incoming.generated = [{ id: 'result', name: '生成穿搭', image: 'seed:shirt', modelImage: 'seed:model', modelId: 'model', modelName: '另一位同 ID 人物', items: [{ id: 'shirt', name: '另一件同 ID 衣服', category: 'top' }] }];
  await api.importBackup(backupFile(incoming));
  const state = api.state(), generated = state.generated[0];
  const importedItem = state.items.find(row => row.name === '另一件同 ID 衣服');
  const importedModel = state.models.find(row => row.name === '另一位同 ID 人物');
  assert.notEqual(importedItem.id, 'shirt');
  assert.notEqual(importedModel.id, 'model');
  assert.equal(generated.items[0].id, importedItem.id);
  assert.equal(generated.modelId, importedModel.id);
});

// The bulk-selection flow pre-populates a new collection object before opening the editor.
// Its presence must not be mistaken for an already-saved collection at the 40-row limit.
test('pre-populated new collection cannot bypass the collection limit', async () => {
  const { api, body } = harness();
  api.state().ow.collections = Array.from({ length: 40 }, (_, index) => ({ id: `existing-${index}`, name: `衣橱 ${index}`, itemIds: ['shirt'] }));
  api.owEditCollection({ id: 'new-from-bulk-selection', name: '新衣橱', itemIds: ['shirt'] });
  const save = descendants(body).find(node => node.tagName === 'BUTTON' && node.textContent === '保存衣橱');
  assert.ok(save);
  await save.fire('click');
  assert.equal(api.state().ow.collections.length, 40);
  assert.equal(api.state().ow.collections.some(row => row.id === 'new-from-bulk-selection'), false);
});

test('merging a legacy backup without wardrobe extensions preserves current preferences', async () => {
  const { api } = harness();
  api.state().ow.preferences = { ...api.state().ow.preferences, occasion: '约会聚餐', style: '宽松自然', height: 165, weight: 52 };
  const before = plain(api.state().ow.preferences);
  await api.importBackup(backupFile(emptyState()));
  assert.deepEqual(plain(api.state().ow.preferences), before);
});
