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
const seed = { assets: {}, items: [], models: [], reference: {
  items: [{id:'reference-shirt',name:'旧衬衫',category:'top',image:png}],
  looks: [{id:'reference-pink',name:'旧视频模特',poster:png,video:'/video-reference/look-pink.mp4',itemIds:[],season:'SUMMER'}]
}, catalog: {
  items:[{id:'asset-tops-01',name:'高清燕麦针织衫',category:'top',color:'燕麦灰',image:'/wardrobe-assets/tops/tops-01-oatmeal-henley.png',example:true}],
  models:Array.from({length:6},(_,i)=>({id:`hq-model-0${i+1}`,name:`高清模特${i+1}`,image:`/model-assets/model-0${i+1}.png`,example:true})),
  looks:Array.from({length:6},(_,i)=>({id:`hq-look-0${i+1}`,modelId:`hq-model-0${i+1}`,name:`高清造型${i+1}`,poster:`/model-assets/model-0${i+1}.png`,itemIds:[],season:'EVERYDAY'}))
} };
const initial = () => ({
  version: 1, items: [], models: [], outfits: [], generated: [], lookMeta: {},
  videoDemo: { mode: 'reference', favoriteById: {}, dateById: {}, hiddenLookIds: [] },
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
  const local = memoryStorage(), objectURLs = [], posted = [], queried = [], compressed = [], timers = new Map();let timerId=0;
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
    compressImage: async value => { compressed.push(value); return value; },
  });
  context.window = { scrollTo() {} };
  // Run the shipped functions; only image decoding and platform APIs are mocked.
  vm.runInContext(storageSource, context);
  vm.runInContext(`${source.slice(0, seam)}
    compress=compressImage;
    globalThis.studio={
      items,find,looks,current,gallery,openItem,renderWardrobe,dressUp,generate,renderVideo,setHomePoster,rotation,rotationSummary,setWardrobeMode,
      setStore:value=>{store=value;},
      setup:values=>{if('service' in values)service=values.service;if('lookId' in values)lookId=values.lookId;if('selected' in values)selected=values.selected;if('model' in values)model=values.model;if('task' in values)task=values.task;if('context' in values)taskContext=values.context;if('busy' in values)busy=values.busy;if('code' in values)code=values.code;if('page' in values)page=values.page;clientId=${JSON.stringify(clientId)};},
      status:()=>({task,context:taskContext,busy,preparing,page,result,state:S(),cameraStream,model,lookId,selected})
    };
  })();`, context, { filename: 'video-studio-under-test.js' });
  const studio = context.studio;
  studio.setStore(store); studio.setup({ code: 'test-invitation' });
  return { studio, store, context, elements, get, records, local, objectURLs, posted, queried, compressed, timers };
}


const tick = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
function all(node){return [node,...(node.children||[]).flatMap(child=>typeof child==='object'?all(child):[])];}
async function click(node){for(const fn of node.handlers.get('click')||[])await fn({currentTarget:node});}

test('existing reference mode opens the sharp catalog and preserves user content and old look IDs',()=>{
  const h=harness();h.store.state.items.push({id:'my-shirt',name:'我的衬衫',category:'top',image:png});
  h.store.state.models.push({id:'my-photo',name:'我的照片',image:png,example:false});
  h.store.state.generated.push({id:'my-output',name:'我的结果',image:png,items:[],createdAt:'2026-10-24'});
  assert.equal(h.studio.current().id,'hq-look-01');
  assert.equal(h.studio.items()[0].id,'asset-tops-01');
  assert.equal(h.studio.looks().some(n=>n.id==='reference-pink'),false);
  assert.equal(h.studio.looks(true).some(n=>n.id==='reference-pink'),true);
  assert.ok(h.studio.looks().some(n=>n.id==='my-output'));
  assert.ok(h.studio.looks().some(n=>n.id==='model-my-photo'));
  h.studio.setWardrobeMode('personal');
  assert.equal(h.studio.items()[0].id,'my-shirt');
  assert.equal(h.store.state.models[0].id,'my-photo');
});

test('home model picker selects an exact sharp model without replacing a user photo',async()=>{
  const h=harness();h.store.state.models.push({id:'personal-model',name:'个人照片',image:png,example:false});
  h.studio.gallery('home');
  const cards=all(h.get('gallery-dialog')).filter(n=>n.className?.includes('gallery-photo'));
  assert.equal(cards.length,7);
  await click(cards[2]);
  assert.equal(h.studio.status().lookId,'hq-look-03');
  assert.equal(h.get('gallery-dialog').open,false);
  assert.equal(h.store.state.models[0].image,png);
  assert.equal(h.get('model-file').dataset.purpose,'home');
});

test('reselecting a hidden catalog model restores only that model',async()=>{
  const h=harness();h.store.state.videoDemo.hiddenLookIds=['hq-look-02','hq-look-03'];
  h.store.state.lookMeta={'hq-look-02':{hidden:true},'hq-look-03':{hidden:true}};
  h.studio.gallery('home');
  await click(all(h.get('gallery-dialog')).filter(n=>n.className?.includes('gallery-photo'))[1]);
  assert.equal(h.studio.current().id,'hq-look-02');
  assert.equal(h.store.state.lookMeta['hq-look-02'].hidden,false);
  assert.deepEqual([...h.store.state.videoDemo.hiddenLookIds],['hq-look-03']);
  assert.equal(h.store.state.lookMeta['hq-look-03'].hidden,true);
});

test('catalog dress-up inherits the selected model and makes a real AI call',async()=>{
  const h=harness();h.studio.setup({selected:['asset-tops-01'],lookId:'hq-look-04'});
  h.studio.dressUp();
  assert.equal(h.studio.status().model.id,'hq-model-04');
  assert.equal(h.studio.status().model.reference,false);
  await h.studio.generate();
  assert.equal(h.posted.length,1);
  assert.equal(h.posted[0][0],'tryOn');
  assert.equal(h.posted[0][1].modelImage,'/model-assets/model-04.png');
  assert.equal(h.posted[0][1].items[0].image,seed.catalog.items[0].image);
  assert.equal(h.store.state.generated.length,1);
  assert.equal(h.store.state.generated[0].modelId,'hq-model-04');
});

test('saving a catalog piece keeps its transparent original and adds it to the personal wardrobe',async()=>{
  const h=harness();h.store.state.items.push({id:'keep-me',name:'原有单品',category:'top',image:png});
  h.studio.openItem(seed.catalog.items[0]);
  const save=all(h.get('recognition-dialog')).find(n=>n.textContent==='保存到我的衣橱');
  assert.ok(save);await click(save);
  const added=h.store.state.items.find(n=>n.id!=='keep-me');
  assert.equal(added.image,seed.catalog.items[0].image);
  assert.equal(added.example,false);
  assert.equal(h.store.state.videoDemo.mode,'personal');
  assert.equal(h.store.state.items.length,2);
});

test('new model has an honest still-photo state and cannot inherit a legacy rotation video',async()=>{
  const legacyVideo=new Blob(['old-video'],{type:'video/mp4'});
  const h=harness({records:new Map([['video-rotation-reference-pink',legacyVideo]])});
  await h.studio.renderVideo(h.studio.current());
  assert.equal(h.get('look-video').hidden,true);
  assert.equal(h.get('look-poster').hidden,false);
  assert.equal(h.get('play-look').hidden,true);
  assert.match(h.get('rotation-hint').textContent,/生成 360° 后/);
  assert.equal(h.objectURLs.length,0);
  assert.equal(await h.records.get('video-rotation-reference-pink').text(),'old-video');
});

test('a slow earlier model download never overwrites the latest selection',async()=>{
  const h=harness(),pending=[];
  h.context.Image=class{set src(value){this.value=value;pending.push(this);}};
  h.studio.setHomePoster(seed.catalog.looks[0]);
  h.studio.setHomePoster(seed.catalog.looks[1]);
  pending.find(i=>i.value.endsWith('model-02.png')).onload();await tick();
  assert.equal(h.get('look-poster').src,'/model-assets/model-02.png');
  pending.find(i=>i.value.endsWith('model-01.png')).onload();await tick();
  assert.equal(h.get('look-poster').src,'/model-assets/model-02.png');
});

test('rotation label follows server metadata and never claims an unconfigured Seedance version',async()=>{
  const h=harness();
  assert.equal(h.studio.rotationSummary(),'Seedance · 5 秒 · 720p');
  h.studio.setup({service:{rotation:{modelLabel:'Seedance 2.0',duration:5,resolution:'720p'}}});
  assert.equal(h.studio.rotationSummary(),'Seedance 2.0 · 5 秒 · 720p');
  h.context.AiyiAPI.status=async()=>({rotationConfigured:true,rotation:{modelLabel:'Seedance 1.0',duration:5,resolution:'720p'}});
  h.studio.rotation();await tick();
  assert.ok(all(h.get('rotation-dialog')).some(n=>n.textContent.startsWith('Seedance 1.0 ·')));
  assert.equal(h.posted.length,0,'opening a dialog only reads free status');
});


const seedance2Status = approvedSourceIds => ({
  authorized:true,configured:true,rotationConfigured:true,remaining:{recognition:5,tryOn:5,rotation:2},
  rotation:{modelLabel:'Seedance 2.0',duration:5,resolution:'720p',requiresApprovedPortrait:true,approvedSourceIds}
});
const rotationButton = h => all(h.get('rotation-dialog')).find(n=>n.textContent==='生成转身视频');

test('approved original catalog portrait uses its source ID without decoding or recompressing its image',async()=>{
  const status=seedance2Status(['hq-model-03']);
  const h=harness({api:{status:async()=>status}});h.studio.setup({lookId:'hq-look-03'});
  h.studio.rotation();
  assert.equal(rotationButton(h).disabled,true,'wait for the current server capability check');
  await tick();assert.equal(rotationButton(h).disabled,false);
  await click(rotationButton(h));
  assert.equal(h.posted.length,1);
  assert.deepEqual(plain(h.posted[0].payload),{sourceId:'hq-model-03'});
  assert.deepEqual(h.compressed,[]);
  const saved=h.records.get(pendingKey);
  assert.equal(saved.context.sourceId,'hq-model-03');
  assert.equal(saved.context.modelImage,'/model-assets/model-03.png','recovery retains the preview independently of the provider input');
  assert.equal(h.get('processing-photo').src,'/model-assets/model-03.png');
});

test('a portrait missing approval disables generation with a usable import-video alternative',async()=>{
  const h=harness({api:{status:async()=>seedance2Status(['hq-model-02'])}});
  h.studio.rotation();await tick();
  assert.equal(rotationButton(h).disabled,true);
  assert.ok(all(h.get('rotation-dialog')).some(n=>n.textContent.includes('这张模特需先完成火山人像入库')));
  const imported=all(h.get('rotation-dialog')).find(n=>n.textContent==='导入 MP4 / MOV / WebM');
  assert.ok(imported);assert.notEqual(imported.disabled,true);
  assert.equal(h.posted.length,0);
});

test('a new try-on image never borrows approval from its original model ID or matching poster path',async()=>{
  const h=harness({api:{status:async()=>seedance2Status(['hq-model-01'])}});
  h.store.state.generated.push({id:'new-try-on',name:'新试穿',modelId:'hq-model-01',image:seed.catalog.models[0].image,items:[],createdAt:'2026-10-24'});
  h.studio.setup({lookId:'new-try-on'});h.studio.rotation();await tick();
  assert.equal(rotationButton(h).disabled,true);
  assert.ok(all(h.get('rotation-dialog')).some(n=>n.textContent.includes('新试穿的图片也需要单独入库')));
  assert.equal(h.posted.length,0);
});

test('approval removed between opening and clicking is rechecked before any submission',async()=>{
  let reads=0;
  const h=harness({api:{status:async()=>seedance2Status(++reads===1?['hq-model-01']:[])}});
  h.studio.rotation();await tick();assert.equal(rotationButton(h).disabled,false);
  await click(rotationButton(h));
  assert.equal(reads,2);
  assert.equal(h.posted.length,0);
  assert.equal(h.studio.status().task,null);
  assert.equal(rotationButton(h).disabled,true);
  assert.match(h.get('toast').textContent,/先完成火山人像入库/);
});

test('Seedance 1.0 keeps the original image upload path for the same catalog portrait',async()=>{
  const h=harness();
  h.studio.rotation();await tick();await click(rotationButton(h));
  assert.equal(h.posted.length,1);
  assert.deepEqual(plain(h.posted[0].payload),{image:'/model-assets/model-01.png'});
  assert.deepEqual(h.compressed,['/model-assets/model-01.png']);
});

test('a failed service check cannot reuse stale portrait approval',async()=>{
  const h=harness({api:{status:async()=>{throw Error('offline');}}});
  h.studio.setup({service:seedance2Status(['hq-model-01'])});
  h.studio.rotation();await tick();
  assert.equal(rotationButton(h).disabled,true);
  assert.ok(all(h.get('rotation-dialog')).some(n=>n.textContent.includes('暂时无法确认视频服务')));
  assert.equal(h.posted.length,0);
});
