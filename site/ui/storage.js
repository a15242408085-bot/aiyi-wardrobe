(() => {
  'use strict';
  const DB_NAME = 'aiyi-offline-v1', STORE = 'state', LIMIT = 50 * 1024 * 1024;
  const categories = new Set(['top', 'outerwear', 'bottom', 'shoes', 'bag']);
  const reserved = new Set(['__proto__', 'prototype', 'constructor']);
  const clone = value => structuredClone(value);
  const text = (value, max = 100) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,110}$/.test(value) && !reserved.has(value);
  const requiredId = value => { if (!isId(value)) throw Error('资料编号无效，请检查备份文件。'); return value; };
  function date(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '';
    const parsed = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : '';
  }
  function budget(value) {
    let json; try { json = JSON.stringify(value); } catch (_) { throw Error('备份资料格式无效。'); }
    if (typeof json !== 'string' || new Blob([json]).size > LIMIT) throw Error('本地衣橱最多保存 50 MB，请先精简图片。');
  }
  // Retain JSON extensions without allowing prototype keys, cycles, or unbounded nesting.
  function safeCopy(value, depth = 0, count = { value: 0 }) {
    if (++count.value > 100000 || depth > 16) throw Error('备份资料层级或内容过多。');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw Error('备份包含无效数字。'); return value; }
    if (typeof value === 'string') { if (value.length > 4500000) throw Error('备份图片过大。'); return value; }
    if (Array.isArray(value)) { if (value.length > 2000) throw Error('备份记录过多。'); return value.map(row => safeCopy(row, depth + 1, count)); }
    if (!value || typeof value !== 'object' || Object.prototype.toString.call(value) !== '[object Object]') throw Error('备份资料格式无效。');
    const result = {};
    const entries = Object.entries(value); if (entries.length > 2000) throw Error('备份字段过多。');
    for (const [key, child] of entries) {
      if (reserved.has(key) || key.length > 150) throw Error('备份包含无效字段。');
      if (child !== undefined) Object.defineProperty(result, key, { value: safeCopy(child, depth + 1, count), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  function image(ref, seed) {
    if (typeof ref !== 'string') return false;
    if (ref.startsWith('seed:')) { const key = ref.slice(5); return isId(key) && Object.hasOwn(seed.assets || {}, key) && image(seed.assets[key], { assets: {} }); }
    if (/^\/video-reference\/[A-Za-z0-9_/-]+\.(?:png|jpe?g|webp)$/i.test(ref) && !ref.includes('..') && !ref.includes('//')) return true;
    if (/^\/wardrobe-assets\/(?:tops|pants|shoes)\/[A-Za-z0-9_-]+\.png$/.test(ref)) return true;
    if (/^\/model-assets\/model-0[1-6]\.png$/.test(ref)) return true;
    return ref.length < 4500000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(ref);
  }
  function rows(source, limit, label, convert) {
    if (!Array.isArray(source) || source.length > limit) throw Error(`${label}数量或格式无效。`);
    const seen = new Set();
    return source.map(raw => {
      if (!raw || typeof raw !== 'object') throw Error(`${label}资料无效。`);
      const row = safeCopy(raw); requiredId(row.id);
      if (seen.has(row.id)) throw Error(`${label}编号重复。`); seen.add(row.id);
      return convert(row);
    });
  }
  const bounded = (value, min, max, fallback = 0) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
  function normalizeOW(raw, items) {
    const source = raw == null ? {} : safeCopy(raw), ids = new Set(items.map(row => row.id));
    const itemIds = values => [...new Set((Array.isArray(values) ? values : []).filter(id => ids.has(id)))].slice(0, 500);
    const result = { ...source };
    result.collections = rows(source.collections || [], 40, '衣橱', row => {
      if (!text(row.name, 60)) throw Error('衣橱名称无效。');
      return { ...row, name: text(row.name, 60), note: text(row.note, 200), itemIds: itemIds(row.itemIds), coverId: ids.has(row.coverId) ? row.coverId : '', createdAt: text(row.createdAt, 40) };
    });
    result.layouts = rows(source.layouts || [], 100, '平铺搭配', row => {
      if (!text(row.name, 60)) throw Error('搭配名称无效。');
      const pieces = rows(row.pieces || [], 20, '搭配单品', piece => ({ ...piece, itemId: requiredId(piece.itemId), x: bounded(piece.x, 0, 100, 50), y: bounded(piece.y, 0, 100, 50), width: bounded(piece.width, 8, 100, 30), rotation: bounded(piece.rotation, -360, 360), z: bounded(piece.z, 0, 100) })).filter(piece => ids.has(piece.itemId));
      return { ...row, name: text(row.name, 60), note: text(row.note, 300), favorite: row.favorite === true, createdAt: text(row.createdAt, 40), updatedAt: text(row.updatedAt, 40), pieces };
    });
    result.itemMeta = {};
    if (source.itemMeta != null && (typeof source.itemMeta !== 'object' || Array.isArray(source.itemMeta))) throw Error('单品详情格式无效。');
    for (const [id, row] of Object.entries(source.itemMeta || {})) if (ids.has(id)) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('单品详情格式无效。');
      result.itemMeta[id] = { ...row, brand: text(row.brand, 60), size: text(row.size, 30), material: text(row.material, 80), season: ['四季', '春秋', '夏季', '冬季'].includes(row.season) ? row.season : '四季', occasion: text(row.occasion, 60), price: row.price === '' || row.price == null ? '' : bounded(row.price, 0, 1000000), purchasedAt: date(row.purchasedAt), wears: [...new Set((Array.isArray(row.wears) ? row.wears : []).map(date).filter(Boolean))].sort().slice(0, 1000), archived: row.archived === true };
    }
    result.plans = rows(source.plans || [], 1000, '穿搭日历', row => {
      if (!date(row.date) || !['item', 'outfit', 'look'].includes(row.kind)) throw Error('穿搭日期或类型无效。');
      return { ...row, date: date(row.date), refId: requiredId(row.refId), status: row.status === 'worn' ? 'worn' : 'planned', note: text(row.note, 200) };
    });
    const prefs = source.preferences || {};
    if (typeof prefs !== 'object' || Array.isArray(prefs)) throw Error('穿搭偏好格式无效。');
    result.preferences = { ...prefs, occasion: text(prefs.occasion, 60) || '日常通勤', style: text(prefs.style, 100), height: bounded(prefs.height, 0, 230), weight: bounded(prefs.weight, 0, 250), bust: bounded(prefs.bust, 0, 180), waist: bounded(prefs.waist, 0, 180), hip: bounded(prefs.hip, 0, 180) };
    return result;
  }
  function normalizeVideo(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}, favoriteById = {}, dateById = {};
    if (Object.keys(source.favoriteById || {}).length > 1000 || Object.keys(source.dateById || {}).length > 1000 || (source.hiddenLookIds?.length || 0) > 1000) throw Error('造型记录数量过多。');
    for (const [id, value] of Object.entries(source.favoriteById || {})) { requiredId(id); if (typeof value === 'boolean') favoriteById[id] = value; }
    for (const [id, value] of Object.entries(source.dateById || {})) { requiredId(id); if (date(value)) dateById[id] = value; }
    return { favoriteById, dateById, hiddenLookIds: [...new Set((Array.isArray(source.hiddenLookIds) ? source.hiddenLookIds : []).map(requiredId))], mode: source.mode === 'personal' ? 'personal' : 'reference' };
  }
  function normalize(raw, seed = {}) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.items) || !Array.isArray(raw.models) || !Array.isArray(raw.outfits)) throw Error('这不是爱衣橱体验版的备份文件。');
    budget(raw);
    const items = rows(raw.items, 500, '衣物', row => {
      if (!text(row.name, 60) || !categories.has(row.category) || !image(row.image, seed)) throw Error('衣物名称、分类或图片格式无效。');
      return { ...row, name: text(row.name, 60), color: text(row.color, 24), notes: text(row.notes, 400), favorite: row.favorite === true, example: row.image.startsWith('seed:') };
    });
    const models = rows(raw.models, 40, '人物', row => {
      if (!text(row.name, 60) || !image(row.image, seed)) throw Error('人物名称或图片格式无效。');
      return { ...row, name: text(row.name, 60), example: row.image.startsWith('seed:'), createdAt: text(row.createdAt, 40) };
    });
    const itemSet = new Set(items.map(row => row.id)), modelSet = new Set(models.map(row => row.id));
    const outfits = rows(raw.outfits, 100, '搭配', row => {
      if (!text(row.name, 60) || !modelSet.has(row.modelId) || !Array.isArray(row.itemIds) || !row.itemIds.length || row.itemIds.length > 5 || new Set(row.itemIds).size !== row.itemIds.length || row.itemIds.some(id => !itemSet.has(id))) throw Error('搭配关联的衣物或人物无效。');
      return { ...row, name: text(row.name, 60), createdAt: text(row.createdAt, 40), itemIds: [...row.itemIds] };
    });
    const generated = rows(raw.generated || [], 100, '试穿记录', row => {
      if (!image(row.image, seed) || !image(row.modelImage, seed) || !Array.isArray(row.items) || !row.items.length || row.items.length > 5) throw Error('试穿记录图片或衣物无效。');
      const seen = new Set(); const snapshots = row.items.map(item => {
        if (!item || !isId(item.id) || seen.has(item.id) || !text(item.name, 60) || !categories.has(item.category)) throw Error('试穿衣物记录无效。');
        seen.add(item.id); return { ...safeCopy(item), name: text(item.name, 60), category: item.category };
      });
      if (row.modelId && !isId(row.modelId)) throw Error('试穿人物编号无效。');
      return { ...row, name: text(row.name, 60) || '我的 AI 试穿', createdAt: text(row.createdAt, 40), modelId: row.modelId || '', modelName: text(row.modelName, 60), prompt: text(row.prompt, 600), items: snapshots };
    });
    const lookMeta = {};
    if (Object.keys(raw.lookMeta || {}).length > 1000) throw Error('造型资料数量过多。');
    for (const [id, meta] of Object.entries(raw.lookMeta || {})) {
      requiredId(id); if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw Error('造型资料格式无效。');
      lookMeta[id] = { ...safeCopy(meta), favorite: meta.favorite === true, hidden: meta.hidden === true, date: date(meta.date) };
    }
    const result = { version: 1, items, models, outfits, generated, lookMeta, ow: normalizeOW(raw.ow, items), videoDemo: normalizeVideo(raw.videoDemo) };
    budget(result); return result;
  }
  const uid = () => globalThis.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const canonical = value => JSON.stringify(value, (_, child) => child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
  function merge(current, incoming, seed = {}) {
    const next = normalize(current, seed), addition = normalize(incoming, seed), itemMap = new Map(), modelMap = new Map(), outfitMap = new Map(), generatedMap = new Map(), layoutMap = new Map();
    function append(target, row, map, originalId = row.id) {
      const existing = target.find(saved => saved.id === row.id);
      if (existing && canonical(existing) === canonical(row)) { map.set(originalId, existing.id); return; }
      if (existing) { const used = new Set(target.map(saved => saved.id)); do { row.id = uid(); } while (used.has(row.id)); }
      target.push(row); map.set(originalId, row.id);
    }
    addition.items.forEach(row => append(next.items, clone(row), itemMap));
    addition.models.forEach(row => append(next.models, clone(row), modelMap));
    addition.outfits.forEach(row => append(next.outfits, { ...row, modelId: modelMap.get(row.modelId) || row.modelId, itemIds: row.itemIds.map(id => itemMap.get(id) || id) }, outfitMap));
    addition.generated.forEach(row => append(next.generated, { ...row, modelId: modelMap.get(row.modelId) || row.modelId, items: row.items.map(item => ({ ...item, id: itemMap.get(item.id) || item.id })) }, generatedMap));
    const lookId = id => generatedMap.get(id) || outfitMap.get(id) || (id.startsWith('model-') && modelMap.has(id.slice(6)) ? `model-${modelMap.get(id.slice(6))}` : id);
    addition.ow.layouts.forEach(row => append(next.ow.layouts, { ...row, pieces: row.pieces.map(piece => ({ ...piece, itemId: itemMap.get(piece.itemId) || piece.itemId })) }, layoutMap));
    const collectionMap = new Map(); addition.ow.collections.forEach(row => append(next.ow.collections, { ...row, itemIds: row.itemIds.map(id => itemMap.get(id) || id), coverId: itemMap.get(row.coverId) || row.coverId }, collectionMap));
    for (const [id, meta] of Object.entries(addition.ow.itemMeta)) {
      const key = itemMap.get(id) || id, saved = next.ow.itemMeta[key];
      next.ow.itemMeta[key] = saved ? { ...meta, ...saved, wears: [...new Set([...meta.wears, ...saved.wears])].sort() } : clone(meta);
    }
    const planMap = new Map(); addition.ow.plans.forEach(row => {
      const refId = row.kind === 'item' ? itemMap.get(row.refId) || row.refId : row.kind === 'outfit' ? layoutMap.get(row.refId) || outfitMap.get(row.refId) || row.refId : lookId(row.refId);
      append(next.ow.plans, { ...row, refId }, planMap);
    });
    next.ow.preferences = { ...addition.ow.preferences, ...next.ow.preferences };
    function mergeExtension(saved, incomingValue) {
      if (canonical(saved) === canonical(incomingValue)) return clone(saved);
      if (Array.isArray(saved) && Array.isArray(incomingValue)) {
        const result = clone(saved), known = new Set(saved.map(canonical));
        for (const row of incomingValue) if (!known.has(canonical(row))) { result.push(clone(row)); known.add(canonical(row)); }
        return result;
      }
      if (saved && incomingValue && typeof saved === 'object' && typeof incomingValue === 'object' && !Array.isArray(saved) && !Array.isArray(incomingValue)) {
        const result = clone(saved);
        for (const [key, value] of Object.entries(incomingValue)) result[key] = Object.hasOwn(result, key) ? mergeExtension(result[key], value) : clone(value);
        return result;
      }
      throw Error('备份中的扩展资料存在冲突，原资料未改动。请分别保留两份备份。');
    }
    for (const [key, value] of Object.entries(addition.ow)) {
      if (['collections', 'layouts', 'itemMeta', 'plans', 'preferences'].includes(key)) continue;
      next.ow[key] = Object.hasOwn(next.ow, key) ? mergeExtension(next.ow[key], value) : clone(value);
    }
    for (const [id, value] of Object.entries(addition.lookMeta)) next.lookMeta[lookId(id)] = clone(value);
    for (const [id, value] of Object.entries(addition.videoDemo.favoriteById)) next.videoDemo.favoriteById[lookId(id)] = value;
    for (const [id, value] of Object.entries(addition.videoDemo.dateById)) next.videoDemo.dateById[lookId(id)] = value;
    next.videoDemo.hiddenLookIds = [...new Set([...next.videoDemo.hiddenLookIds, ...addition.videoDemo.hiddenLookIds.map(lookId)])];
    return normalize(next, seed);
  }
  async function create(seed = {}) {
    const initial = normalize({ version: 1, items: clone(seed.items || []), models: clone(seed.models || []), outfits: [], generated: [], lookMeta: {} }, seed);
    let db, queue = Promise.resolve(), protectedOriginal = false;
    const memoryRecords = new Map();
    const store = { state: initial, mode: 'memory', save, getBlob, putBlob, deleteBlob, getRecord, putRecord, deleteRecord };
    let local; try { local = globalThis.localStorage; } catch (_) { /* Security-restricted storage is optional. */ }
    try {
      db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1); let done = false;
        const timer = setTimeout(() => { done = true; reject(Error('storage unavailable')); }, 2500);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
        req.onsuccess = () => { if (done) { req.result.close(); return; } done = true; clearTimeout(timer); resolve(req.result); };
        req.onerror = req.onblocked = () => { done = true; clearTimeout(timer); reject(req.error || Error('storage unavailable')); };
      });
      const saved = await read('wardrobe');
      if (saved != null) { try { store.state = normalize(saved, seed); } catch (_) { protectedOriginal = true; return store; } }
      else if (local?.getItem(DB_NAME)) { try { store.state = normalize(JSON.parse(local.getItem(DB_NAME)), seed); } catch (_) { protectedOriginal = true; return store; } }
      store.mode = 'indexedDB';
    } catch (_) {
      try {
        const saved = local?.getItem(DB_NAME);
        if (saved) { try { store.state = normalize(JSON.parse(saved), seed); } catch (_) { protectedOriginal = true; return store; } }
        if (!local) return store;
        local.setItem(`${DB_NAME}-probe`, '1'); local.removeItem(`${DB_NAME}-probe`); store.mode = 'localStorage';
      } catch (_) { /* A complete temporary wardrobe remains usable. */ }
    }
    function read(key) { return new Promise((resolve, reject) => { const tx = db.transaction(STORE), req = tx.objectStore(STORE).get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
    function write(key, value, remove = false) { return new Promise((resolve, reject) => { const tx = db.transaction(STORE, 'readwrite'); if (remove) tx.objectStore(STORE).delete(key); else tx.objectStore(STORE).put(value, key); tx.oncomplete = () => resolve(true); tx.onerror = tx.onabort = () => reject(tx.error || Error('浏览器未能保存资料。')); }); }
    async function save() {
      // Validate before queuing so invalid imports never replace saved personal data.
      const snapshot = normalize(store.state, seed); store.state = snapshot;
      const operation = queue.catch(() => {}).then(async () => {
        if (protectedOriginal || store.mode === 'memory') return false;
        if (store.mode === 'indexedDB') return write('wardrobe', snapshot);
        local.setItem(DB_NAME, JSON.stringify(snapshot)); return true;
      });
      queue = operation; return operation;
    }
    function recordKey(key) { if (!isId(key) || key === 'wardrobe') throw Error('本地记录编号无效。'); return key; }
    async function getRecord(key) { recordKey(key); if (db) return read(key); return memoryRecords.get(key); }
    async function putRecord(key, value) { recordKey(key); if (protectedOriginal) return false; if (db) return write(key, clone(value)); memoryRecords.set(key, clone(value)); return false; }
    async function deleteRecord(key) { recordKey(key); if (protectedOriginal) return false; if (db) return write(key, undefined, true); memoryRecords.delete(key); return false; }
    async function getBlob(key) { const result = await getRecord(`video-blob-${recordKey(key)}`); if (result instanceof Blob) return result; if (key === 'rotation') { const legacy = await getRecord('rotation'); return legacy instanceof Blob ? legacy : legacy?.file instanceof Blob ? legacy.file : null; } return null; }
    async function putBlob(key, value) { if (!(value instanceof Blob) || value.size > 100 * 1024 * 1024) throw Error('本地视频最多保存 100 MB。'); return putRecord(`video-blob-${recordKey(key)}`, value); }
    async function deleteBlob(key) { return deleteRecord(`video-blob-${recordKey(key)}`); }
    return store;
  }
  globalThis.AiyiStorage = Object.freeze({ create, normalize, merge });
})();
