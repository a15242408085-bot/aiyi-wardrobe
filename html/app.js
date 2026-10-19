(() => {
  'use strict';
  const seed = JSON.parse(document.getElementById('aiyi-seed').textContent);
  const $ = (id) => document.getElementById(id);
  const categories = { top: '上衣', outerwear: '外套', bottom: '下装', shoes: '鞋子', bag: '包袋' };
  const STORE_KEY = 'aiyi-warm-html-20261019-v1';
  const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
  const fitsBudget = value => new Blob([JSON.stringify(value)]).size <= MAX_BACKUP_BYTES;
  let state = { version: 1, items: structuredClone(seed.items), models: structuredClone(seed.models), outfits: [] };
  let filter = 'all', currentPage = 'wardrobe';
  let selected = [...seed.example.itemIds], modelId = seed.example.modelId;
  let db = null, storageMode = 'memory', saveQueue = Promise.resolve(), toastTimer;
  let itemPhoto = '', modelPhoto = '', photoVersion = 0, modelPhotoVersion = 0, videoURL = '';
  const uid = () => globalThis.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const asset = (ref) => ref?.startsWith('seed:') ? seed.assets[ref.slice(5)] || '' : ref || '';
  const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const imageRef = (ref) => typeof ref === 'string' && (Object.hasOwn(seed.assets, ref.startsWith('seed:') ? ref.slice(5) : '') || (ref.length < 4500000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(ref)));
  const el = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  function button(label, onClick, className = '') {
    const node = el('button', className, label);
    node.type = 'button'; node.addEventListener('click', onClick);
    return node;
  }
  function picture(ref, alt, className = '') {
    const node = el('img', className);
    node.src = asset(ref); node.alt = alt; node.loading = 'lazy'; node.decoding = 'async';
    return node;
  }
  function toast(message) {
    clearTimeout(toastTimer); $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
  }
  function status(message) { $('storage-status').textContent = message; }
  function sanitize(input) {
    if (!input || input.version !== 1 || !Array.isArray(input.items) || !Array.isArray(input.models) || !Array.isArray(input.outfits)) throw Error('这不是爱衣橱体验版的备份文件。');
    if (!fitsBudget(input)) throw Error('本地衣橱最多保存 50 MB，请先精简图片。');
    if (input.items.length > 500 || input.models.length > 40 || input.outfits.length > 100) throw Error('备份内容过多，请分批整理。');
    const ids = new Set();
    const items = input.items.map((r) => {
      if (!r || !text(r.id, 100) || r.id !== text(r.id, 100) || ids.has(r.id) || !text(r.name, 60) || !Object.hasOwn(categories, r.category) || !imageRef(r.image)) throw Error('备份中的衣物资料或图片格式无效。');
      ids.add(r.id);
      return { id: text(r.id, 100), name: text(r.name, 60), category: r.category, color: text(r.color, 24), notes: text(r.notes, 400), image: r.image, favorite: r.favorite === true, example: r.image.startsWith('seed:') };
    });
    const modelIds = new Set();
    const models = input.models.map((r) => {
      if (!r || !text(r.id, 100) || r.id !== text(r.id, 100) || modelIds.has(r.id) || !text(r.name, 60) || !imageRef(r.image)) throw Error('备份中的模特资料无效。');
      modelIds.add(r.id);
      return { id: text(r.id, 100), name: text(r.name, 60), image: r.image, example: r.image.startsWith('seed:') };
    });
    const outfitIds = new Set();
    const outfits = input.outfits.map((r) => {
      if (!r || !text(r.id, 100) || r.id !== text(r.id, 100) || outfitIds.has(r.id) || !text(r.name, 60) || !modelIds.has(r.modelId) || !Array.isArray(r.itemIds) || !r.itemIds.length || r.itemIds.length > 5 || new Set(r.itemIds).size !== r.itemIds.length || r.itemIds.some(id => !ids.has(id))) throw Error('备份中的搭配资料无效。');
      const cats = r.itemIds.map(id => items.find(item => item.id === id).category);
      if (new Set(cats).size !== cats.length) throw Error('每套搭配的同一分类只能有一件衣物。');
      outfitIds.add(r.id);
      return { id: text(r.id, 100), name: text(r.name, 60), modelId: r.modelId, itemIds: [...r.itemIds] };
    });
    return { version: 1, items, models, outfits };
  }
  async function openStorage() {
    try {
      db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(STORE_KEY, 1);
        let done = false;
        const timer = setTimeout(() => { done = true; reject(Error('storage unavailable')); }, 2500);
        request.onupgradeneeded = () => request.result.createObjectStore('state');
        request.onsuccess = () => { if (done) { request.result.close(); return; } done = true; clearTimeout(timer); resolve(request.result); };
        request.onerror = () => { clearTimeout(timer); reject(request.error); };
        request.onblocked = () => { clearTimeout(timer); done = true; reject(Error('storage blocked')); };
      });
      storageMode = 'indexedDB';
      const saved = await new Promise((resolve, reject) => {
        const tx = db.transaction('state'); const req = tx.objectStore('state').get('wardrobe');
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
      if (saved) {
        try { state = sanitize(saved); }
        catch (_) { storageMode = 'memory'; status('原有资料读取失败 · 本次临时使用'); toast('原备份未被覆盖，请重新打开文件或导入有效备份。'); return; }
      }
      status('已开启本地保存');
    } catch (_) {
      try {
        const saved = localStorage.getItem(STORE_KEY);
        if (saved) {
          try { state = sanitize(JSON.parse(saved)); }
          catch (_) { storageMode = 'memory'; status('原有资料读取失败 · 本次临时使用'); toast('原备份未被覆盖，请重新打开文件或导入有效备份。'); return; }
        }
        localStorage.setItem(`${STORE_KEY}-probe`, '1'); localStorage.removeItem(`${STORE_KEY}-probe`);
        storageMode = 'localStorage'; status('已开启本地保存');
      } catch (_) { storageMode = 'memory'; status('当前仅临时保存 · 请导出备份'); }
    }
    selected = selected.filter(id => state.items.some(item => item.id === id));
    if (!state.models.some(m => m.id === modelId)) modelId = state.models[0]?.id || '';
  }
  function persist() {
    const saved = structuredClone(state);
    saveQueue = saveQueue.then(async () => {
      try {
        if (storageMode === 'indexedDB') await new Promise((resolve, reject) => {
          const tx = db.transaction('state', 'readwrite');
          tx.objectStore('state').put(saved, 'wardrobe');
          tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
        });
        else if (storageMode === 'localStorage') localStorage.setItem(STORE_KEY, JSON.stringify(saved));
        else throw Error('memory');
        status('已保存到此浏览器');
        return true;
      } catch (_) {
        status('本次修改未持久保存 · 请导出备份');
        toast('浏览器无法保存这次修改，请点“导出备份”保留衣橱。');
        return false;
      }
    });
    return saveQueue;
  }
  function navigate(page, focus = true) {
    const titles = { wardrobe: ['我的衣橱', '整理你的喜欢，搭出自己的日常。'], fitting: ['搭配灵感', '选好模特和衣物，搭出今天的样子。'], models: ['模特与 360', '保存全身参考图，导入视频查看更多角度。'], about: ['体验版说明', '一个文件，随时打开；你的衣橱，留在本地。'] };
    currentPage = page;
    document.querySelectorAll('[data-view]').forEach(node => { node.hidden = node.dataset.view !== page; });
    document.querySelectorAll('[data-page]').forEach(node => {
      const active = node.dataset.page === page;
      node.classList.toggle('active', active);
      if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
    });
    $('nav-current-label').textContent = titles[page][0]; $('app-title').textContent = titles[page][0]; $('page-subtitle').textContent = titles[page][1];
    if (page !== 'models') $('rotation-video').pause();
    if (focus) { $('app-title').tabIndex = -1; $('app-title').focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
  }
  function renderWardrobe() {
    $('item-count').textContent = state.items.length;
    $('category-count').textContent = new Set(state.items.map(i => i.category)).size;
    $('favorite-count').textContent = state.items.filter(i => i.favorite).length;
    document.querySelectorAll('[data-filter]').forEach(node => { node.setAttribute('aria-pressed', String(node.dataset.filter === filter)); node.classList.toggle('active', node.dataset.filter === filter); });
    const query = $('search-input').value.trim().toLowerCase();
    const items = state.items.filter(i => (filter === 'all' || (filter === 'favorites' ? i.favorite : i.category === filter)) && `${i.name} ${i.color} ${i.notes} ${categories[i.category]}`.toLowerCase().includes(query));
    const sort = $('sort-items').value;
    if (sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    if (sort === 'category') items.sort((a, b) => Object.keys(categories).indexOf(a.category) - Object.keys(categories).indexOf(b.category));
    $('visible-count').textContent = `共 ${state.items.length} 件 · 当前 ${items.length} 件`;
    $('wardrobe-grid').replaceChildren(...items.map(item => {
      const card = el('article', 'item-card');
      const photo = button('', () => showImage(item.image, item.name), 'item-image');
      photo.setAttribute('aria-label', `查看${item.name}大图`); photo.append(picture(item.image, item.name));
      const body = el('div', 'item-body'); body.append(el('h3', '', item.name), el('p', 'item-meta', `${categories[item.category]} · ${item.color || '未填写颜色'}`));
      const actions = el('div', 'card-actions');
      const favorite = button(item.favorite ? '♥ 已收藏' : '♡ 收藏', () => { item.favorite = !item.favorite; persist(); renderWardrobe(); }, 'favorite-button');
      favorite.setAttribute('aria-pressed', String(item.favorite)); favorite.setAttribute('aria-label', `${item.favorite ? '取消收藏' : '收藏'}${item.name}`);
      actions.append(favorite, button('编辑', () => openItem(item), 'text-button'));
      body.append(actions); card.append(photo, body); return card;
    }));
    if (filter === 'all' && !query) {
      const add = button('', () => openItem(), 'add-garment-card');
      add.setAttribute('aria-label', '添加一件新的衣物');
      add.append(el('span', 'add-card-icon', '+'), el('strong', '', '下一件喜欢，放这里'), el('span', '', '添加自己的衣物照片'));
      $('wardrobe-grid').append(add);
    }
    $('wardrobe-empty').hidden = items.length !== 0 || (filter === 'all' && !query);
  }
  function originalOutfit() {
    const currentModel = state.models.find(m => m.id === modelId);
    if (currentModel?.image !== seed.models[0].image || selected.length !== seed.items.length) return false;
    return seed.items.every(original => selected.some(id => {
      const item = state.items.find(i => i.id === id);
      return item?.image === original.image && item.category === original.category;
    }));
  }
  function renderFitting() {
    $('model-select').replaceChildren(...state.models.map(model => {
      const option = el('option', '', model.name); option.value = model.id; return option;
    }));
    $('model-select').value = modelId;
    const model = state.models.find(m => m.id === modelId);
    $('fitting-model-image').hidden = !model;
    if (model) { $('fitting-model-image').src = asset(model.image); $('fitting-model-image').alt = model.name; }
    $('selected-count').textContent = `${selected.length} / 5`;
    $('fitting-items').replaceChildren(...state.items.map(item => {
      const selectedNow = selected.includes(item.id);
      const node = button('', () => {
        selected = selectedNow ? selected.filter(id => id !== item.id) : [...selected.filter(id => state.items.find(i => i.id === id)?.category !== item.category), item.id];
        renderFitting();
      }, 'fitting-item');
      node.setAttribute('aria-pressed', String(selectedNow));
      node.append(picture(item.image, ''), el('strong', '', item.name), el('span', '', `${categories[item.category]}${selectedNow ? ' · 已选' : ''}`));
      return node;
    }));
    if (!state.items.length) $('fitting-items').append(el('p', 'muted', '衣橱还是空的，先去添加一件衣物。'));
    $('result-panel').hidden = true;
    $('save-outfit').disabled = selected.length === 0 || !model;
    $('show-result').disabled = !originalOutfit();
    $('show-result').textContent = originalOutfit() ? '查看这套实测效果' : '新搭配需联网生成';
    $('fitting-help').textContent = originalOutfit() ? '这套搭配有已生成的真人质感效果。点击查看，无需联网。' : '可以保存这套搭配。离线体验版无法为新衣物或新模特生成试穿图；点击“载入示例搭配”可看已有案例。';
    renderOutfits();
  }
  function renderOutfits() {
    $('saved-outfits').replaceChildren(...state.outfits.map(outfit => {
      const card = el('article', 'outfit-card'); const thumbs = el('div', 'outfit-thumbnails');
      outfit.itemIds.forEach(id => { const item = state.items.find(i => i.id === id); if (item) thumbs.append(picture(item.image, item.name)); });
      const actions = el('div', 'card-actions');
      actions.append(button('载入搭配', () => { modelId = outfit.modelId; selected = [...outfit.itemIds]; $('outfit-name').value = outfit.name; renderFitting(); toast(`已载入「${outfit.name}」`); }), button('删除', () => {
        if (!confirm(`删除搭配「${outfit.name}」？衣物会保留。`)) return;
        state.outfits = state.outfits.filter(o => o.id !== outfit.id); persist(); renderOutfits();
      }, 'text-button'));
      card.append(thumbs, el('h3', '', outfit.name), actions); return card;
    }));
    if (!state.outfits.length) $('saved-outfits').append(el('p', 'muted', '还没有保存的搭配。选好衣物，给今天的穿搭起个名字吧。'));
  }
  function renderModels() {
    $('model-grid').replaceChildren(...state.models.map(model => {
      const card = el('article', 'model-card'); const photo = button('', () => showImage(model.image, model.name), 'model-image');
      photo.setAttribute('aria-label', `查看${model.name}大图`); photo.append(picture(model.image, model.name));
      const body = el('div', 'model-body'); body.append(el('h3', '', model.name), el('p', 'item-meta', model.image === seed.models[0].image ? 'AI 生成的虚构成年模特 · 全身参考图' : '你添加的模特 · 全身参考图'));
      const actions = el('div', 'card-actions'); actions.append(button('去搭配', () => { modelId = model.id; renderFitting(); navigate('fitting'); }));
      if (model.id !== seed.models[0].id) actions.append(button('删除', () => {
        if (!confirm(`删除模特「${model.name}」及其已保存的搭配？`)) return;
        state.models = state.models.filter(m => m.id !== model.id); state.outfits = state.outfits.filter(o => o.modelId !== model.id);
        if (modelId === model.id) modelId = state.models[0]?.id || '';
        persist(); renderAll();
      }, 'text-button'));
      body.append(actions); card.append(photo, body); return card;
    }));
  }
  function renderAll() { renderWardrobe(); renderFitting(); renderModels(); }
  function showImage(ref, title) {
    $('image-dialog-title').textContent = title; $('image-dialog-image').src = asset(ref); $('image-dialog-image').alt = title;
    $('image-dialog-download').href = asset(ref); $('image-dialog-download').download = `${title.replace(/[\\/:*?"<>|]/g, '-')}.jpg`;
    $('image-dialog').showModal();
  }
  function preview(id, ref) { $(id).hidden = !ref; if (ref) $(id).src = asset(ref); else $(id).removeAttribute('src'); }
  function openItem(item) {
    photoVersion++; $('item-form').reset(); $('item-id').value = item?.id || '';
    $('item-name').value = item?.name || ''; $('item-category').value = item?.category || 'top';
    $('item-color').value = item?.color || ''; $('item-notes').value = item?.notes || '';
    itemPhoto = item?.image || ''; preview('item-preview', itemPhoto);
    $('item-form-error').textContent = ''; $('item-save').disabled = false; $('item-delete').hidden = !item;
    const title = $('item-dialog').querySelector('h2'); if (title) title.textContent = item ? '编辑衣物' : '添加衣物';
    $('item-dialog').showModal();
  }
  async function readPhoto(file) {
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw Error('请选择 JPG、PNG 或 WebP 图片。');
    if (file.size > 20 * 1024 * 1024) throw Error('图片超过 20 MB，请选择小一点的图片。');
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const node = new Image(); node.onload = () => resolve(node); node.onerror = () => reject(Error('图片无法读取，请换一张试试。')); node.src = url;
      });
      const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.88);
    } finally { URL.revokeObjectURL(url); }
  }
  async function choosePhoto(kind) {
    const isItem = kind === 'item', token = isItem ? ++photoVersion : ++modelPhotoVersion;
    const input = $(isItem ? 'item-image-input' : 'model-image-input'), error = $(isItem ? 'item-form-error' : 'model-error'), save = $(isItem ? 'item-save' : 'model-save');
    if (!input.files?.[0]) return;
    error.textContent = ''; save.disabled = true;
    try {
      const ref = await readPhoto(input.files[0]);
      if (token !== (isItem ? photoVersion : modelPhotoVersion)) return;
      if (isItem) itemPhoto = ref; else modelPhoto = ref;
      preview(isItem ? 'item-preview' : 'model-preview', ref);
    } catch (e) { if (token === (isItem ? photoVersion : modelPhotoVersion)) error.textContent = e.message; }
    finally { if (token === (isItem ? photoVersion : modelPhotoVersion)) save.disabled = false; }
  }
  function loadExample() {
    const missingItems = seed.items.filter(original => !state.items.some(i => i.image === original.image && i.category === original.category)).length;
    const missingModel = !state.models.some(m => m.image === seed.models[0].image);
    if (state.items.length + missingItems > 500 || state.models.length + Number(missingModel) > 40 || new Blob([JSON.stringify(state)]).size + 10000 > MAX_BACKUP_BYTES) { toast('衣橱容量不足，请先整理衣物或模特，再载入示例。'); return; }
    selected = seed.items.map(original => {
      const found = state.items.find(i => i.image === original.image && i.category === original.category);
      if (found) return found.id;
      const item = { ...original, id: uid() }; state.items.push(item); return item.id;
    });
    const existing = state.models.find(m => m.image === seed.models[0].image);
    if (existing) modelId = existing.id;
    else { const model = { ...seed.models[0], id: uid() }; state.models.push(model); modelId = model.id; }
    $('outfit-name').value = '暖黄色的日常'; persist(); renderAll();
    toast('已载入 5 件衣物的实测搭配。');
  }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob), link = el('a'); link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function importBackup(file) {
    if (!file) return;
    if (file.size > 60 * 1024 * 1024) throw Error('备份文件超过 60 MB，无法导入。');
    const incoming = sanitize(JSON.parse(await file.text())), next = structuredClone(state), itemMap = new Map(), modelMap = new Map();
    for (const [rows, target, map] of [[incoming.items, next.items, itemMap], [incoming.models, next.models, modelMap]]) {
      for (const row of rows) {
        const existing = target.find(r => r.id === row.id);
        if (existing && JSON.stringify(existing) === JSON.stringify(row)) map.set(row.id, existing.id);
        else {
          const added = { ...row, id: existing ? uid() : row.id }; map.set(row.id, added.id); target.push(added);
        }
      }
    }
    incoming.outfits.forEach(outfit => {
      const added = { ...outfit, modelId: modelMap.get(outfit.modelId), itemIds: outfit.itemIds.map(id => itemMap.get(id)) };
      if (!next.outfits.some(o => o.name === added.name && o.modelId === added.modelId && JSON.stringify(o.itemIds) === JSON.stringify(added.itemIds))) next.outfits.push({ ...added, id: uid() });
    });
    state = sanitize(next);
    if (!modelId) modelId = state.models[0]?.id || '';
    const saved = await persist(); renderAll(); if (saved) toast('备份已合并到当前衣橱。原有衣物已保留。');
  }
  function clearVideo() {
    const video = $('rotation-video'); video.pause(); video.removeAttribute('src'); video.load();
    if (videoURL) URL.revokeObjectURL(videoURL); videoURL = '';
    $('video-input').value = ''; $('video-stage').hidden = true; $('video-empty').hidden = false;
    $('video-scrub').value = 0; $('video-time').textContent = '0:00 / 0:00'; $('video-play').textContent = '播放';
  }
  const seconds = value => `${Math.floor((Number.isFinite(value) ? value : 0) / 60)}:${String(Math.floor((Number.isFinite(value) ? value : 0) % 60)).padStart(2, '0')}`;
  function setupVideo() {
    const video = $('rotation-video'); let drag = null;
    $('video-input').addEventListener('change', () => {
      const file = $('video-input').files?.[0]; if (!file) return;
      if ((!['video/mp4', 'video/quicktime', 'video/webm'].includes(file.type) && !/\.(mp4|mov|webm)$/i.test(file.name)) || file.size > 100 * 1024 * 1024) { toast('请选择 100 MB 以内的 MP4、MOV 或 WebM 视频。'); $('video-input').value = ''; return; }
      clearVideo(); videoURL = URL.createObjectURL(file); video.src = videoURL;
      $('video-label').textContent = `${file.name} · 仅在本次打开中保留`;
    });
    video.addEventListener('loadedmetadata', () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) { clearVideo(); toast('这个视频暂时无法读取，请换一个 MP4 视频。'); return; }
      $('video-empty').hidden = true; $('video-stage').hidden = false;
      $('video-time').textContent = `${seconds(0)} / ${seconds(video.duration)}`;
    });
    video.addEventListener('error', () => { if (videoURL) { clearVideo(); toast('浏览器无法播放这个格式，建议使用 H.264 编码的 MP4。'); } });
    video.addEventListener('timeupdate', () => { $('video-scrub').value = video.duration ? Math.round(video.currentTime / video.duration * 1000) : 0; $('video-time').textContent = `${seconds(video.currentTime)} / ${seconds(video.duration)}`; });
    video.addEventListener('play', () => { $('video-play').textContent = '暂停'; });
    video.addEventListener('pause', () => { $('video-play').textContent = '播放'; });
    $('video-play').addEventListener('click', async () => { try { if (video.paused) await video.play(); else video.pause(); } catch (_) { toast('视频暂时无法播放，请重新导入。'); } });
    $('video-scrub').addEventListener('input', () => { video.pause(); if (video.duration) video.currentTime = Number($('video-scrub').value) / 1000 * video.duration; });
    $('video-clear').addEventListener('click', clearVideo);
    video.style.touchAction = 'pan-y';
    video.addEventListener('pointerdown', event => { if (!video.duration) return; video.pause(); drag = { x: event.clientX, t: video.currentTime }; video.setPointerCapture(event.pointerId); });
    video.addEventListener('pointermove', event => { if (drag) video.currentTime = Math.min(video.duration, Math.max(0, drag.t + (event.clientX - drag.x) / Math.max(video.clientWidth, 1) * video.duration)); });
    video.addEventListener('pointerup', () => { drag = null; }); video.addEventListener('pointercancel', () => { drag = null; });
    window.addEventListener('pagehide', () => { video.pause(); });
  }
  function bind() {
    document.querySelectorAll('[data-page]').forEach(node => node.addEventListener('click', () => navigate(node.dataset.page)));
    document.querySelectorAll('[data-filter]').forEach(node => node.addEventListener('click', () => { filter = node.dataset.filter; renderWardrobe(); }));
    document.querySelectorAll('[data-close-dialog]').forEach(node => node.addEventListener('click', () => node.closest('dialog').close()));
    $('search-input').addEventListener('input', renderWardrobe);
    $('sort-items').addEventListener('change', renderWardrobe);
    document.querySelectorAll('[data-add-item]').forEach(node => node.addEventListener('click', () => openItem()));
    $('add-item').addEventListener('click', () => openItem());
    $('item-image-input').addEventListener('change', () => choosePhoto('item'));
    $('model-image-input').addEventListener('change', () => choosePhoto('model'));
    $('item-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (!itemPhoto || !text($('item-name').value, 60)) { $('item-form-error').textContent = '请添加图片并填写衣物名称。'; return; }
      const id = $('item-id').value, existing = state.items.find(i => i.id === id);
      if (!existing && state.items.length >= 500) { $('item-form-error').textContent = '衣橱最多可保存 500 件，请先导出并整理。'; return; }
      const item = { id: existing?.id || uid(), name: text($('item-name').value, 60), category: $('item-category').value, color: text($('item-color').value, 24), notes: text($('item-notes').value, 400), image: itemPhoto, favorite: existing?.favorite || false, example: itemPhoto.startsWith('seed:') };
      const nextItems = existing ? state.items.map(i => i.id === id ? item : i) : [item, ...state.items];
      if (!fitsBudget({ ...state, items: nextItems })) { $('item-form-error').textContent = '衣橱图片已接近 50 MB，请先导出备份并整理一些衣物。'; return; }
      state.items = nextItems;
      // Category edits must not leave two pieces of the same type in a saved look.
      const uniqueCategories = ids => { const seen = new Set(); return ids.filter(id => { const cat = state.items.find(i => i.id === id)?.category; if (!cat || seen.has(cat)) return false; seen.add(cat); return true; }); };
      selected = uniqueCategories(selected); state.outfits.forEach(o => { o.itemIds = uniqueCategories(o.itemIds); });
      $('item-dialog').close(); renderAll(); if (await persist()) toast(existing ? '衣物已更新。' : '衣物已加入衣橱。');
    });
    $('item-delete').addEventListener('click', async () => {
      const id = $('item-id').value, item = state.items.find(i => i.id === id); if (!item || !confirm(`删除「${item.name}」？相关搭配中也会移除这件衣物。`)) return;
      state.items = state.items.filter(i => i.id !== id); selected = selected.filter(i => i !== id);
      state.outfits = state.outfits.map(o => ({ ...o, itemIds: o.itemIds.filter(i => i !== id) })).filter(o => o.itemIds.length);
      $('item-dialog').close(); renderAll(); if (await persist()) toast('衣物已删除。');
    });
    $('add-model').addEventListener('click', () => { modelPhotoVersion++; modelPhoto = ''; $('model-form').reset(); preview('model-preview', ''); $('model-error').textContent = ''; $('model-save').disabled = false; $('model-dialog').showModal(); });
    $('model-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (!modelPhoto || !text($('model-name').value, 60)) { $('model-error').textContent = '请添加全身照片并填写模特名称。'; return; }
      if (state.models.length >= 40) { $('model-error').textContent = '最多可保存 40 个模特，请先整理。'; return; }
      const model = { id: uid(), name: text($('model-name').value, 60), image: modelPhoto, example: false };
      if (!fitsBudget({ ...state, models: [...state.models, model] })) { $('model-error').textContent = '衣橱图片已接近 50 MB，请先导出备份并整理。'; return; }
      state.models.push(model); modelId = model.id; $('model-dialog').close(); renderAll(); if (await persist()) toast('模特已添加，可前往试衣间搭配。');
    });
    $('model-select').addEventListener('change', event => { modelId = event.target.value; renderFitting(); });
    $('load-example').addEventListener('click', loadExample);
    $('save-outfit').addEventListener('click', async () => {
      if (!selected.length || !modelId) return;
      if (state.outfits.length >= 100) { toast('最多可保存 100 套搭配，请先整理。'); return; }
      const name = text($('outfit-name').value, 60) || `我的搭配 ${state.outfits.length + 1}`;
      const outfit = { id: uid(), name, modelId, itemIds: [...selected] };
      if (!fitsBudget({ ...state, outfits: [outfit, ...state.outfits] })) { toast('本地衣橱已满，请先导出并整理。'); return; }
      state.outfits.unshift(outfit); renderOutfits(); if (await persist()) toast(`「${name}」已保存。`);
    });
    $('show-result').addEventListener('click', () => {
      if (!originalOutfit()) return;
      $('result-before').src = asset(seed.models[0].image); $('result-before').alt = '换装前：中国女生全身参考图';
      $('result-after').src = asset(seed.example.result); $('result-after').alt = '换装后：黄色 Polo、米白外套、蓝色阔腿裤、黑白运动鞋与黑棕托特包';
      $('result-description').textContent = seed.example.description;
      $('download-result').href = asset(seed.example.result); $('download-result').download = '爱衣橱-五件套实测试穿.jpg';
      $('result-panel').hidden = false; $('result-panel').scrollIntoView({ behavior: 'auto', block: 'start' });
    });
    $('view-collage').addEventListener('click', () => showImage(seed.example.collage, '实测搭配原图'));
    $('export-data').addEventListener('click', () => { downloadBlob(new Blob([JSON.stringify(state)], { type: 'application/json' }), `爱衣橱备份-${new Date().toISOString().slice(0, 10)}.json`); toast('备份已导出。可用“导入备份”恢复到这份 HTML。'); });
    $('import-data').addEventListener('change', async event => { try { await importBackup(event.target.files?.[0]); } catch (e) { toast(e instanceof SyntaxError ? '文件不是有效的 JSON 备份。' : e.message); } finally { event.target.value = ''; } });
    setupVideo();
  }
  async function init() { $('hero-model').src = asset('seed:hero'); await openStorage(); bind(); renderAll(); navigate('wardrobe', false); window.appReady = true; }
  init().catch(() => { status('页面未能初始化，请重新打开文件'); });
})();
