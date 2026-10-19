(() => {
  'use strict';
  const seed = JSON.parse(document.getElementById('aiyi-seed').textContent);
  const $ = (id) => document.getElementById(id);
  const categories = { top: '上衣', outerwear: '外套', bottom: '下装', shoes: '鞋子', bag: '包袋' };
  const STORE_KEY = 'aiyi-offline-v1';
  const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
  const fitsBudget = value => new Blob([JSON.stringify(value)]).size <= MAX_BACKUP_BYTES;
  let state = { version: 1, items: structuredClone(seed.items), models: structuredClone(seed.models), outfits: [], generated: [] };
  let filter = 'all', currentPage = 'fitting', studioFilter = 'all';
  let previewMode = 'example', previewSelectionSignature = null;
  let selected = [...seed.example.itemIds], modelId = seed.example.modelId;
  let focusedItemId = seed.items.find(item => item.category === 'outerwear')?.id || seed.items[0]?.id;
  let videoContext = null;
  let db = null, storageMode = 'memory', saveQueue = Promise.resolve(), toastTimer;
  let itemPhoto = '', modelPhoto = '', photoVersion = 0, modelPhotoVersion = 0, videoURL = '';
  const AI_CLIENT_KEY = 'aiyi-ai-client-v1', AI_CODE_KEY = 'aiyi-ai-code-v1', AI_PENDING_KEY = 'aiyi-ai-pending-v1';
  const MAX_AI_IMAGE_BYTES = 1800000;
  let clientId = '', accessCode = '', aiStatus = null, aiBusy = false, aiChecking = false, aiPending = null, aiContext = null;
  let recognitionPhoto = '', recognitionCandidates = [], recognitionPhotoVersion = 0, recognitionPreparing = false, recognitionSaving = false;
  let pendingSaveQueue = Promise.resolve(), reviewSaveTimer, aiTick, currentGenerated = null, aiCheckVersion = 0;
  const originalResults = new Map();
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
    if (input.generated !== undefined && (!Array.isArray(input.generated) || input.generated.length > 100)) throw Error('试穿记录格式无效或数量过多。');
    const generatedIds = new Set();
    const generated = (input.generated || []).map(r => {
      if (!r || !text(r.id, 100) || r.id !== text(r.id, 100) || generatedIds.has(r.id) || !imageRef(r.image) || !imageRef(r.modelImage) || !Array.isArray(r.items) || !r.items.length || r.items.length > 5 || r.items.some(item => !item || !text(item.id, 100) || !text(item.name, 60) || !Object.hasOwn(categories, item.category))) throw Error('备份中的 AI 试穿记录无效。');
      generatedIds.add(r.id);
      return {id: r.id, name: text(r.name, 60) || '我的 AI 试穿', createdAt: text(r.createdAt, 40), image: r.image, modelImage: r.modelImage, modelId: text(r.modelId, 100), modelName: text(r.modelName, 60), prompt: text(r.prompt, 600), items: r.items.map(item => ({id: text(item.id, 100), name: text(item.name, 60), category: item.category}))};
    });
    return { version: 1, items, models, outfits, generated };
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
    const titles = { wardrobe: ['我的衣橱', '把喜欢的衣物收好，让每一天都有得穿。'], fitting: ['搭配工作台', '从自己的衣橱里，搭出今天喜欢的样子。'], models: ['我的模特', '保存全身参考图，导入转身视频查看更多角度。'], about: ['使用说明', '你的衣橱留在本地，在线 AI 按需使用。'] };
    if (!Object.hasOwn(titles, page)) page = 'fitting';
    currentPage = page;
    document.body.dataset.page = page;
    document.querySelectorAll('[data-view]').forEach(node => { node.hidden = node.dataset.view !== page; });
    document.querySelectorAll('a[data-page],button[data-page]').forEach(node => {
      const active = node.dataset.page === page;
      node.classList.toggle('active', active);
      if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
    });
    $('app-title').textContent = titles[page][0]; $('page-subtitle').textContent = titles[page][1];
    if (page !== 'models') $('rotation-video').pause();
    if (page !== 'fitting') $('studio-rotation-video')?.pause();
    if (location.hash !== `#${page}`) { try { history.replaceState(null, '', `#${page}`); } catch (_) {} }
    if (focus) { $('app-title').tabIndex = -1; $('app-title').focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
  }
  function renderWardrobe() {
    $('item-count').textContent = state.items.length;
    $('category-count').textContent = new Set(state.items.map(i => i.category)).size;
    $('favorite-count').textContent = state.items.filter(i => i.favorite).length;
    document.querySelectorAll('[data-filter]').forEach(node => { node.setAttribute('aria-pressed', String(node.dataset.filter === filter)); node.classList.toggle('active', node.dataset.filter === filter); });
    const query = $('search-input').value.trim().toLowerCase();
    const items = state.items.filter(i => (filter === 'all' || (filter === 'favorites' ? i.favorite : i.category === filter)) && `${i.name} ${i.color} ${i.notes} ${categories[i.category]}`.toLowerCase().includes(query));
    $('wardrobe-grid').replaceChildren(...items.map(item => {
      const card = el('article', 'item-card');
      const photo = button('', () => showImage(item.image, item.name), 'item-image');
      photo.setAttribute('aria-label', `查看${item.name}大图`); photo.append(picture(item.image, item.name));
      const body = el('div', 'item-body'); body.append(el('h3', '', item.name), el('p', 'item-meta', `${categories[item.category]} · ${item.color || '未填写颜色'}`));
      const actions = el('div', 'card-actions');
      const favorite = button(item.favorite ? '♥ 已收藏' : '♡ 收藏', () => { item.favorite = !item.favorite; persist(); renderWardrobe(); renderFitting(); }, 'favorite-button');
      favorite.setAttribute('aria-pressed', String(item.favorite)); favorite.setAttribute('aria-label', `${item.favorite ? '取消收藏' : '收藏'}${item.name}`);
      actions.append(favorite, button('编辑', () => openItem(item), 'text-button'), button('去搭配', () => { selectItem(item.id, true); navigate('fitting'); }, 'text-button'));
      body.append(actions); card.append(photo, body); return card;
    }));
    $('wardrobe-empty').hidden = items.length !== 0;
  }
  function originalOutfit() {
    const currentModel = state.models.find(m => m.id === modelId);
    if (currentModel?.image !== seed.models[0].image || selected.length !== seed.items.length) return false;
    return seed.items.every(original => selected.some(id => {
      const item = state.items.find(i => i.id === id);
      return item?.image === original.image && item.category === original.category;
    }));
  }
  function selectItem(id, keepSelected = false) {
    const item = state.items.find(i => i.id === id);
    if (!item) return;
    focusedItemId = item.id;
    selected = selected.includes(id) && !keepSelected ? selected.filter(i => i !== id) : [...selected.filter(i => state.items.find(other => other.id === i)?.category !== item.category), id];
    renderFitting();
  }
  function renderStudioPreview() {
    if (!$('studio-preview-label')) return;
    const model = state.models.find(m => m.id === modelId);
    const signature = [modelId, model?.image, ...selected.flatMap(id => { const item = state.items.find(i => i.id === id); return [id, item?.image, item?.category]; })];
    if (previewSelectionSignature && (signature.length !== previewSelectionSignature.length || signature.some((value, index) => value !== previewSelectionSignature[index]))) previewMode = originalOutfit() ? 'example' : 'base';
    previewSelectionSignature = signature;
    if (previewMode === 'example' && !originalOutfit()) previewMode = 'base';
    if (previewMode === 'generated' && !currentGenerated) previewMode = 'base';
    let ref = model?.image || '', title = '人物底图', note = selected.length ? '选好衣物后，点击下方「生成 AI 试穿」查看上身效果。' : '从衣橱选择一件衣物，开始今天的搭配。';
    if (previewMode === 'example') { ref = seed.example.result; title = '示例搭配 · 展示图'; note = '展示图已处理背景，原始试穿结果可在「示例前后对比」中查看。'; }
    if (previewMode === 'generated') { ref = originalResults.get(currentGenerated.id) || currentGenerated.image; title = '已生成 · ' + currentGenerated.name; note = '展示这次提交时的搭配结果，当前选择不会改写已生成的图片。'; }
    $('fitting-model-image').hidden = !ref;
    $('fitting-model-image').classList.toggle('is-cutout', previewMode === 'example');
    if (ref) { $('fitting-model-image').src = previewMode === 'example' ? '/studio/model-outfit-cutout.png' : asset(ref); $('fitting-model-image').dataset.original = asset(ref); $('fitting-model-image').alt = title; } else $('fitting-model-image').removeAttribute('src');
    $('studio-model-name').textContent = previewMode === 'generated' ? currentGenerated.modelName || '历史试穿人物' : model?.name || '添加一张人物照片';
    $('studio-preview-label').textContent = title;
    $('studio-preview-status').textContent = note;
    $('studio-preview-open').disabled = !ref;
    $('studio-preview-example').disabled = !originalOutfit();
    $('studio-preview-latest').disabled = !currentGenerated && !state.generated.length;
    $('studio-preview-latest').textContent = '已生成效果';
    for (const [id, mode] of [['studio-preview-base','base'],['studio-preview-example','example'],['studio-preview-latest','generated']]) { $(id).setAttribute('aria-pressed', String(previewMode === mode)); $(id).classList.toggle('active', previewMode === mode); }
    renderStudioRotation();
  }
  function renderStudioDetails() {
    if (!$('studio-detail-name')) return;
    const item = state.items.find(row => row.id === focusedItemId) || state.items.find(row => selected.includes(row.id)) || state.items[0];
    focusedItemId = item?.id;
    const itemName = item?.name || '从一件衣服开始';
    $('studio-detail-name').textContent = /^[\u3400-\u9fff]{5,10}$/.test(itemName) ? itemName.slice(0,-3) + '\n' + itemName.slice(-3) : itemName;
    $('studio-detail-category').textContent = categories[item?.category] || '我的衣橱';
    $('studio-detail-color').textContent = item?.color || '未填写颜色';
    $('studio-detail-notes').textContent = item?.notes || '选一件自己的衣服，看看它和衣橱里的其他单品有多合拍。';
    const colors = [['米白','#e9e1d4'],['奶白','#eee5d8'],['白','#f4f0e7'],['黑','#292724'],['棕','#926548'],['蓝','#344f6d'],['黄','#d2a33a'],['红','#af4d40'],['粉','#dca6a0'],['绿','#7a8460'],['灰','#a4a29f'],['紫','#928092']];
    $('studio-detail-color-swatch').style.backgroundColor = colors.find(([name]) => (item?.color || '').includes(name))?.[1] || '#c6aa94';
    if ($('studio-detail-photo')) { $('studio-detail-photo').hidden = !item; if (item) $('studio-detail-photo').src = asset(item.image); }
    $('studio-detail-tags').replaceChildren(...[categories[item?.category] || '我的衣物', item?.favorite ? '我的收藏' : '个人衣橱', selected.includes(item?.id) ? '已加入搭配' : '待选单品'].map(value => el('span', '', value)));
    const orbitItems = ['shoes','top','outerwear','bottom','bag'].map(category => state.items.find(row => row.category === category && selected.includes(row.id)) || state.items.find(row => row.category === category));
    $('studio-orbit').replaceChildren(...orbitItems.map((choice, index) => {
      const category = ['shoes','top','outerwear','bottom','bag'][index];
      const control = button('', () => {
        studioFilter = category; $('studio-search').value = '';
        if (choice) focusedItemId = choice.id;
        renderFitting();
      }, `orbit-item${choice?.id === focusedItemId ? ' active' : ''}`);
      control.setAttribute('aria-label', choice ? `查看${categories[category]}款式：${choice.name}` : `挑选${categories[category]}`);
      control.setAttribute('aria-pressed', String(choice?.id === focusedItemId));
      if (choice) control.append(picture(choice.image, '')); else control.append(el('span', '', '+'));
      control.append(el('span', 'orbit-item-label', categories[category])); return control;
    }));
  }
  function renderSelection() {
    if (!$('studio-selection')) return;
    $('studio-selection').replaceChildren(...Object.entries(categories).map(([category, label]) => {
      const item = state.items.find(i => selected.includes(i.id) && i.category === category);
      const row = el('div', `selection-row${item ? '' : ' selection-row-empty'}`);
      if (!item) {
        const add = button(`＋ 选择${label}`, () => { studioFilter = category; $('studio-search').value = ''; renderFitting(); $('studio-filters').scrollIntoView({block:'nearest', behavior:'auto'}); }, 'selection-empty-button');
        row.append(add); return row;
      }
      const photo = button('', () => showImage(item.image, item.name), 'selection-row-photo');
      photo.setAttribute('aria-label', `查看${item.name}`); photo.append(picture(item.image, item.name));
      const body = el('div', 'selection-row-body'); body.append(el('strong', '', item.name), el('span', '', `${label} · ${item.color || '未填写颜色'}`));
      const remove = button('×', () => { selected = selected.filter(id => id !== item.id); renderFitting(); }, 'selection-row-remove');
      remove.setAttribute('aria-label', `移除${item.name}`); row.append(photo, body, remove); return row;
    }));
    $('studio-clear').disabled = !selected.length;
    $('studio-selection-summary').textContent = selected.length ? `已搭配 ${selected.length} 件 · ${new Set(selected.map(id => state.items.find(i => i.id === id)?.category)).size} 类单品` : '还未选衣物，先挑一件喜欢的。';
  }
  function renderFitting() {
    $('model-select').replaceChildren(...state.models.map(model => {
      const option = el('option', '', model.name); option.value = model.id; return option;
    }));
    $('model-select').value = modelId;
    const model = state.models.find(m => m.id === modelId);
    renderStudioPreview();
    $('selected-count').textContent = `${selected.length} / 5`;
    const query = ($('studio-search')?.value || '').trim().toLowerCase();
    const choices = state.items.filter(item => (studioFilter === 'all' || (studioFilter === 'favorites' ? item.favorite : item.category === studioFilter)) && `${item.name} ${item.color} ${item.notes} ${categories[item.category]}`.toLowerCase().includes(query));
    document.querySelectorAll('[data-studio-filter]').forEach(node => { const active = node.dataset.studioFilter === studioFilter; node.setAttribute('aria-pressed', String(active)); node.classList.toggle('active', active); });
    if ($('studio-grid-count')) $('studio-grid-count').textContent = `${choices.length} 件衣物`;
    $('fitting-items').replaceChildren(...choices.map(item => {
      const selectedNow = selected.includes(item.id);
      const node = button('', () => selectItem(item.id), 'fitting-item');
      node.setAttribute('aria-pressed', String(selectedNow));
      node.setAttribute('aria-label', `${selectedNow ? '取消选择' : '选择'}${item.name}`);
      node.append(picture(item.image, ''), el('strong', '', item.name), el('span', '', `${item.color || categories[item.category]}${selectedNow ? ' · 已选' : ''}`));
      return node;
    }));
    if (!choices.length) $('fitting-items').append(el('p', 'muted', state.items.length ? '没有找到这类衣物，试试其他分类，或上传一件新衣物。' : '衣橱还是空的，上传自己的衣物开始整理。'));
    renderSelection();
    renderStudioDetails();
    $('result-panel').hidden = true;
    $('save-outfit').disabled = selected.length === 0 || !model;
    $('show-result').disabled = !originalOutfit();
    $('show-result').textContent = '示例前后对比';
    $('fitting-help').textContent = '每类选一件，同类新选择会替换上一件。';
    renderOutfits();
    renderGeneratedHistory(); renderAI();
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
  function dataBytes(value) { const content = value.split(',')[1] || ''; return Math.floor(content.length * 3 / 4) - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0); }
  function loadImage(source) { return new Promise((resolve, reject) => { const node = new Image(); node.onload = () => resolve(node); node.onerror = () => reject(Error('图片无法读取，请换一张试试。')); node.src = source; }); }
  function encodeCanvas(canvas) {
    for (const quality of [.88, .78, .68, .58]) { const value = canvas.toDataURL('image/jpeg', quality); if (dataBytes(value) <= MAX_AI_IMAGE_BYTES) return value; }
    throw Error('图片内容过大，请换一张分辨率较小的照片。');
  }
  async function compressImage(source) {
    const image = await loadImage(source);
    const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d'); if (!context) throw Error('浏览器暂时无法处理图片。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return encodeCanvas(canvas);
  }
  async function readPhoto(file) {
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw Error('请选择 JPG、PNG 或 WebP 图片。');
    if (file.size > 20 * 1024 * 1024) throw Error('图片超过 20 MB，请选择小一点的图片。');
    const url = URL.createObjectURL(file);
    try {
      return await compressImage(url);
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
    studioFilter = 'all'; $('studio-search').value = ''; previewMode = 'example';
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
    incoming.generated.forEach(record => {
      const same = next.generated.find(existing => existing.id === record.id);
      if (!same || JSON.stringify(same) !== JSON.stringify(record)) next.generated.push({...record, id: same ? uid() : record.id});
    });
    state = sanitize(next);
    if (!modelId) modelId = state.models[0]?.id || '';
    const saved = await persist(); renderAll(); if (saved) toast('备份已合并到当前衣橱。原有衣物已保留。');
  }
  function makeClientId() {
    try { const saved = localStorage.getItem(AI_CLIENT_KEY); if (/^[a-zA-Z0-9_-]{32,80}$/.test(saved || '')) return saved; } catch (_) { /* Browser storage can be unavailable. */ }
    const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
    const id = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(AI_CLIENT_KEY, id); } catch (_) { /* Pending context also retains the client identifier. */ }
    return id;
  }
  function apiHeaders(code = accessCode) { return {'Content-Type': 'application/json', 'X-Aiyi-Code': code}; }
  function aiAllowed(kind) { return !!(accessCode && aiStatus?.authorized && aiStatus.configured && Number(aiStatus.remaining?.[kind]) > 0); }
  function apiMessage(data, fallback) { return text(data?.message, 500) || text(data?.error, 500) || fallback; }
  function expireAccess() { aiCheckVersion++; accessCode = ''; aiStatus = null; try { sessionStorage.removeItem(AI_CODE_KEY); } catch (_) {} }
  async function readApiJSON(response, code = accessCode) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { if (response.status === 401 && code === accessCode) expireAccess(); const error = Error(apiMessage(data, `请求未完成（${response.status}），请稍后再试。`)); error.apiStatus = response.status; throw error; }
    return data;
  }
  async function checkAI(code = accessCode, quiet = false) {
    if (!code || !clientId) return false;
    const revision = ++aiCheckVersion;
    if (!quiet) { aiChecking = true; $('ai-global-error').textContent = ''; renderAI(); }
    try {
      const response = await fetch(`/api/ai/status?clientId=${encodeURIComponent(clientId)}`, {headers: apiHeaders(code), credentials: 'omit', cache: 'no-store'});
      const data = await readApiJSON(response, code);
      if (!data.authorized) throw Error('体验码未通过验证，请检查后重新输入。');
      if (revision !== aiCheckVersion) return false;
      accessCode = code; aiStatus = data;
      try { sessionStorage.setItem(AI_CODE_KEY, code); } catch (_) { /* In-memory access still works for this page. */ }
      $('ai-code').value = '';
      return true;
    } catch (error) {
      if (!quiet) $('ai-global-error').textContent = error.message || '暂时连不上 AI 服务，请检查网络。';
      return false;
    } finally { aiChecking = false; renderAI(); }
  }
  function pendingMetadata() {
    if (!aiPending) return null;
    return {requestId: aiPending.requestId, taskId: aiPending.taskId || aiPending.requestId, clientId, kind: aiPending.kind, phase: aiPending.phase, startedAt: aiPending.startedAt, message: text(aiPending.message, 500)};
  }
  function savePending() {
    const metadata = pendingMetadata(), context = aiContext ? structuredClone(aiContext) : null;
    try { if (metadata) localStorage.setItem(AI_PENDING_KEY, JSON.stringify(metadata)); else localStorage.removeItem(AI_PENDING_KEY); } catch (_) {}
    pendingSaveQueue = pendingSaveQueue.catch(() => {}).then(async () => {
      if (!db) return false;
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction('state', 'readwrite');
          if (metadata) tx.objectStore('state').put({metadata, context}, 'ai-pending'); else tx.objectStore('state').delete('ai-pending');
          tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
        }); return true;
      } catch (_) { return false; }
    });
    return pendingSaveQueue;
  }
  function clearPending() { aiPending = null; aiContext = null; clearTimeout(reviewSaveTimer); return savePending(); }
  async function restorePending() {
    let metadata, stored;
    try { metadata = JSON.parse(localStorage.getItem(AI_PENDING_KEY) || 'null'); } catch (_) {}
    if (db) try { stored = await new Promise((resolve, reject) => { const req = db.transaction('state').objectStore('state').get('ai-pending'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); } catch (_) {}
    if (!metadata) metadata = stored?.metadata;
    if (!metadata || !['recognition', 'tryOn'].includes(metadata.kind) || !/^[a-zA-Z0-9_-]{16,100}$/.test(metadata.requestId || '') || !Number.isFinite(metadata.startedAt)) return;
    if (/^[a-zA-Z0-9_-]{32,80}$/.test(metadata.clientId || '')) {
      clientId = metadata.clientId; try { localStorage.setItem(AI_CLIENT_KEY, clientId); } catch (_) {}
    }
    aiPending = {...metadata, taskId: metadata.requestId, phase: metadata.phase === 'review' ? 'review' : 'disconnected'};
    aiContext = stored?.metadata?.requestId === metadata.requestId ? stored.context : null;
    if (aiPending.kind === 'tryOn' && state.generated.some(record => record.id === aiPending.requestId)) { await clearPending(); return; }
    if (aiPending.kind === 'recognition' && aiPending.phase === 'review' && Array.isArray(aiContext?.garments)) {
      recognitionPhoto = imageRef(aiContext.image) ? asset(aiContext.image) : '';
      await prepareCandidates(aiContext.garments, aiContext.edits);
    } else { aiPending.phase = 'disconnected'; aiPending.message = '页面已重新打开。启用 AI 后，可查询上一次任务的结果。'; }
  }
  function renderAI() {
    if (!$('ai-enable')) return;
    const enabled = !!(accessCode && aiStatus?.authorized);
    if ($('studio-ai-short-status')) $('studio-ai-short-status').textContent = aiBusy ? 'AI 处理中' : enabled && aiStatus.configured ? 'AI 已连接' : 'AI 服务';
    $('ai-enable').disabled = aiChecking || aiBusy;
    $('ai-enable').textContent = aiChecking ? '正在验证…' : enabled ? '更新体验码' : '启用 AI';
    $('ai-code').disabled = aiChecking || aiBusy;
    $('ai-lock').hidden = !enabled; $('ai-lock').disabled = aiBusy;
    $('ai-access-status').textContent = enabled ? (aiStatus.configured ? 'AI 已启用，个人衣橱仍保存在此浏览器。' : '体验码已验证，AI 服务尚未准备好。') : '尚未启用 AI，整理衣橱和查看示例仍可使用。';
    $('ai-quota').textContent = enabled ? `剩余：识别 ${aiStatus.remaining?.recognition ?? 0} / ${aiStatus.limits?.recognition ?? 0} 次 · 试穿 ${aiStatus.remaining?.tryOn ?? 0} / ${aiStatus.limits?.tryOn ?? 0} 次` : '';
    const hasSelection = selected.length > 0 && state.models.some(model => model.id === modelId);
    $('ai-try-on').disabled = aiBusy || !!aiPending || !aiAllowed('tryOn') || !hasSelection;
    $('ai-try-on').textContent = aiBusy && aiPending?.kind === 'tryOn' ? '正在生成试穿…' : '生成 AI 试穿';
    $('ai-try-on-hint').textContent = aiPending ? '当前任务的状态可在「AI 服务」中查看；结果未明时请查询，不要重复生成。' : !enabled ? '点「AI 服务」填写体验码，即可生成新试穿图。' : !aiStatus.configured ? 'AI 服务尚未配置完成。' : !aiAllowed('tryOn') ? '本次体验的试穿次数已用完。' : !hasSelection ? '请选择人物和至少一件衣物。' : `剩余 ${aiStatus.remaining.tryOn} 次试穿 · 本次生成使用 1 次`;
    $('recognition-start').disabled = aiBusy || recognitionPreparing || !!aiPending || !recognitionPhoto || !aiAllowed('recognition');
    $('recognition-start').textContent = recognitionPreparing ? '正在处理照片…' : '开始识别';
    $('recognition-image-input').disabled = aiBusy || recognitionPreparing || (!!aiPending && !(aiPending.kind === 'recognition' && aiPending.phase === 'review' && !recognitionPhoto));
    $('recognition-view-source').hidden = !recognitionPhoto;
    $('recognition-status').textContent = aiPending?.kind === 'recognition' ? (aiPending.phase === 'review' ? (recognitionPhoto ? '识别已完成，请检查并确认要保存的衣物。' : '原图未能从本机恢复。请重新选择同一张照片，才能裁剪并保存识别结果；无需再次识别。') : '正在处理这次识别，可以在「AI 服务」中查看任务状态。') : !enabled ? '请先关闭这个窗口，在「AI 服务」中填写体验码后再开始。' : !aiAllowed('recognition') ? '识别服务暂不可用，或体验次数已用完。' : '点击开始后才会发送这张照片，并使用 1 次识别额度。';
    $('recognition-confirm-form').hidden = !recognitionCandidates.length;
    $('recognition-confirm').disabled = aiBusy || recognitionSaving || !recognitionPhoto || !recognitionCandidates.some(candidate => candidate.selected);
    $('recognition-confirm').textContent = recognitionSaving ? '正在保存…' : `确认入库 ${recognitionCandidates.filter(candidate => candidate.selected).length} 件`;
    $('ai-task-panel').hidden = !aiPending;
    if (aiPending) {
      const elapsed = Math.max(0, Math.floor((Date.now() - aiPending.startedAt) / 1000));
      $('ai-task-title').textContent = aiPending.kind === 'recognition' ? '本次衣物识别' : '本次 AI 试穿';
      $('ai-task-status').textContent = aiPending.phase === 'review' ? '识别完成，等待你确认入库。' : aiPending.phase === 'ready' ? 'AI 已生成结果，等待保存到本机。' : aiBusy ? `${aiPending.message || 'AI 正在处理'} · 已等待 ${elapsed} 秒` : `${aiPending.message || '连接已中断，请查询结果。'} · 提交于 ${new Date(aiPending.startedAt).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})}`;
      $('ai-task-note').textContent = aiBusy ? '请保持页面打开和网络连接。等待时间不代表完成进度。' : aiPending.phase === 'review' ? '只有确认后才会加入你的个人衣橱。' : '查询只读取这次任务，不会重新生成或再次使用次数。';
      $('ai-query').hidden = aiPending.phase === 'review'; $('ai-query').disabled = aiBusy || !enabled;
      $('ai-query').textContent = aiBusy ? '处理中…' : '查询结果';
      $('ai-review').hidden = aiPending.kind !== 'recognition' || aiPending.phase !== 'review';
      $('ai-dismiss').hidden = aiBusy || aiPending.phase === 'review';
    }
  }
  async function cropCandidate(source, bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some(value => !Number.isFinite(value)) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) return source;
    const image = await loadImage(source), width = image.naturalWidth, height = image.naturalHeight;
    const left = Math.max(0, Math.floor((bbox[0] - .025) * width)), top = Math.max(0, Math.floor((bbox[1] - .025) * height));
    const right = Math.min(width, Math.ceil((bbox[2] + .025) * width)), bottom = Math.min(height, Math.ceil((bbox[3] + .025) * height));
    if (right - left < 2 || bottom - top < 2) return source;
    const canvas = document.createElement('canvas'); canvas.width = right - left; canvas.height = bottom - top;
    const ctx = canvas.getContext('2d'); if (!ctx) return source;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return encodeCanvas(canvas);
  }
  async function prepareCandidates(garments, edits) {
    if (!Array.isArray(garments)) throw Error('识别结果格式不完整，请查询结果或稍后再试。');
    const supported = garments.filter(garment => garment && Object.hasOwn(categories, garment.category)).slice(0, 8);
    if (!supported.length) throw Error('没有识别到可保存的上衣、外套、下装、鞋或包，请换一张清晰照片。');
    recognitionCandidates = await Promise.all(supported.map(async (garment, index) => {
      const edit = Array.isArray(edits) ? edits[index] : null;
      let image = recognitionPhoto;
      if (recognitionPhoto) try { image = await cropCandidate(recognitionPhoto, garment.bbox); } catch (_) { /* The original remains available when cropping fails. */ }
      return {name: text(edit?.name ?? garment.name, 60) || categories[garment.category], category: Object.hasOwn(categories, edit?.category) ? edit.category : garment.category, color: text(edit?.color ?? garment.color, 24), notes: text(edit?.notes ?? garment.notes, 400), selected: edit?.selected !== false, useOriginal: edit?.useOriginal === true, image};
    }));
    preview('recognition-preview', recognitionPhoto); renderCandidates(); renderAI();
  }
  function rememberCandidateEdits() {
    if (!aiContext) return;
    aiContext.edits = recognitionCandidates.map(({name, category, color, notes, selected, useOriginal}) => ({name, category, color, notes, selected, useOriginal}));
    clearTimeout(reviewSaveTimer); reviewSaveTimer = setTimeout(() => { void savePending(); }, 350);
  }
  function renderCandidates() {
    $('recognition-candidates').replaceChildren(...recognitionCandidates.map((candidate, index) => {
      const row = el('article', 'recognition-candidate');
      const toggle = el('label', 'candidate-toggle'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = candidate.selected;
      checkbox.addEventListener('change', () => {
        candidate.selected = checkbox.checked;
        row.querySelectorAll('.candidate-edit-fields input,.candidate-edit-fields select,.candidate-edit-fields textarea').forEach(input => { input.disabled = !candidate.selected; });
        row.querySelector('.candidate-edit-fields input').required = candidate.selected;
        row.querySelector('.candidate-original input').disabled = !candidate.selected || !recognitionPhoto;
        rememberCandidateEdits(); renderAI();
      }); toggle.append(checkbox, el('span', '', `保存第 ${index + 1} 件`));
      const img = picture(candidate.useOriginal ? recognitionPhoto : candidate.image, candidate.name); if (!recognitionPhoto) img.hidden = true;
      const fields = el('div', 'candidate-edit-fields');
      const makeField = (label, key, maxLength) => { const wrapper = el('label', 'field-label', label); const input = el(key === 'notes' ? 'textarea' : 'input'); input.value = candidate[key]; input.maxLength = maxLength; input.disabled = !candidate.selected; input.setAttribute('aria-label', `${label} ${index + 1}`); if (key === 'name') input.required = candidate.selected; input.addEventListener('input', () => { candidate[key] = input.value; rememberCandidateEdits(); }); wrapper.append(input); return wrapper; };
      const categoryLabel = el('label', 'field-label', '类别'); const select = el('select'); select.setAttribute('aria-label', `类别 ${index + 1}`); select.disabled = !candidate.selected;
      Object.entries(categories).forEach(([value, label]) => { const option = el('option', '', label); option.value = value; select.append(option); }); select.value = candidate.category;
      select.addEventListener('change', () => { candidate.category = select.value; rememberCandidateEdits(); }); categoryLabel.append(select);
      fields.append(makeField('衣物名称', 'name', 60), categoryLabel, makeField('颜色', 'color', 24), makeField('备注', 'notes', 400));
      const sourceToggle = el('label', 'candidate-original'); const sourceCheck = el('input'); sourceCheck.type = 'checkbox'; sourceCheck.checked = candidate.useOriginal; sourceCheck.disabled = !candidate.selected || !recognitionPhoto;
      sourceCheck.addEventListener('change', () => { candidate.useOriginal = sourceCheck.checked; img.src = candidate.useOriginal ? recognitionPhoto : candidate.image; rememberCandidateEdits(); }); sourceToggle.append(sourceCheck, el('span', '', '改用上传原图'));
      row.append(toggle, img, fields, sourceToggle); return row;
    }));
  }
  function openRecognition() {
    $('recognition-error').textContent = '';
    preview('recognition-preview', recognitionPhoto); renderAI();
    if (!$('recognition-dialog').open) $('recognition-dialog').showModal();
  }
  async function finishRecognition(result) {
    if (!Array.isArray(result?.garments) || !result.garments.some(garment => Object.hasOwn(categories, garment?.category))) throw Error('识别完成，但没有可保存的衣物信息。');
    aiContext = {...aiContext, garments: result.garments, edits: aiContext?.edits || []};
    recognitionPhoto = imageRef(aiContext.image) ? asset(aiContext.image) : '';
    aiPending.phase = 'review'; await savePending();
    await prepareCandidates(result.garments, aiContext.edits);
    if (![...document.querySelectorAll('dialog')].some(dialog => dialog.open && dialog.id !== 'recognition-dialog')) openRecognition();
    toast('识别已完成，请检查后确认入库。');
  }
  function showGenerated(record, original = originalResults.get(record.id)) {
    currentGenerated = record;
    previewMode = 'generated'; previewSelectionSignature = null; renderStudioPreview();
    $('ai-result-before').hidden = !record.modelImage;
    if (record.modelImage) $('ai-result-before').src = asset(record.modelImage); else $('ai-result-before').removeAttribute('src');
    $('ai-result-before').alt = `本次提交的人物：${record.modelName || '人物照片'}`;
    $('ai-result-before').closest('figure').querySelector('figcaption').textContent = record.modelImage ? '本次提交的人物' : '本次人物原图未在浏览器保留';
    $('ai-result-after').src = original || asset(record.image);
    $('ai-result-download').href = original || asset(record.image);
    const extension = (original || record.image).startsWith('data:image/png') ? 'png' : (original || record.image).startsWith('data:image/webp') ? 'webp' : 'jpg';
    $('ai-result-download').download = `爱衣橱-${record.name}.${extension}`;
    $('ai-result-download').textContent = original ? '下载原始效果图' : '下载已保存效果图';
    $('ai-result-description').textContent = `${record.name} · 使用提交时的人物「${record.modelName || '人物照片'}」与 ${record.items.map(item => item.name).join('、')}。请检查衣物细节与人物一致性。`;
    $('ai-result-panel').hidden = false;
  }
  async function saveGenerated(record) {
    const exists = state.generated.some(saved => saved.id === record.id);
    const next = {...state, generated: exists ? state.generated : [record, ...state.generated]};
    if (next.generated.length > 100 || !fitsBudget(next)) {
      $('ai-result-save-note').textContent = '本机衣橱空间不足，结果尚未保存。请先下载原始图片，再整理衣橱后点击重新保存。';
      $('ai-save-result').hidden = false; return false;
    }
    state = next;
    const saved = await persist();
    $('ai-result-save-note').textContent = saved ? '已将适合浏览的图片和本次提交信息保存到此浏览器，可随备份导出。原始清晰图片请现在下载保留。' : '结果目前只在本页内存中，请下载图片或导出备份，避免关闭页面后丢失。';
    $('ai-save-result').hidden = saved; renderGeneratedHistory();
    return saved;
  }
  async function finishTryOn(result) {
    const raw = result?.imageDataUrl;
    if (typeof raw !== 'string' || raw.length > 40000000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw Error('服务返回的试穿图片无法读取，请查询本次任务。');
    aiPending.phase = 'ready'; await savePending();
    if (!imageRef(aiContext?.modelImage) || !Array.isArray(aiContext?.items)) {
      const recovered = {id: aiPending.requestId, name: '恢复的 AI 试穿结果', modelImage: '', modelName: '', items: [], image: raw};
      originalResults.set(recovered.id, raw); showGenerated(recovered, raw);
      $('ai-result-description').textContent = '这是上次任务实际返回的图片。本次提交快照未能从浏览器恢复，因此没有套用当前选中的人物和衣物。';
      $('ai-result-save-note').textContent = '请直接下载原始效果图保留。缺少提交信息，本次结果无法加入完整试穿历史。'; $('ai-save-result').hidden = true;
      toast('上次的试穿图片已找到，请前往搭配工作台下载。'); return;
    }
    const record = {id: aiPending.requestId, name: text(aiContext.name, 60) || '我的 AI 试穿', createdAt: new Date(aiPending.startedAt).toISOString(), modelImage: aiContext.modelImage, modelId: aiContext.modelId, modelName: aiContext.modelName, items: aiContext.items, prompt: text(aiContext.prompt, 600), image: raw};
    originalResults.set(record.id, raw); showGenerated(record, raw);
    $('ai-result-save-note').textContent = '正在保存本次结果…';
    record.image = await compressImage(raw);
    if (await saveGenerated(record)) await clearPending();
    if (currentPage === 'fitting') $('fitting-model-image').scrollIntoView({behavior: 'auto', block: 'center'});
    toast('本次 AI 试穿已完成，可查看并下载结果。');
  }
  function renderGeneratedHistory() {
    if (!$('ai-history')) return;
    $('ai-history-section').hidden = !state.generated.length;
    $('ai-history').replaceChildren(...state.generated.map(record => {
      const card = el('article', 'outfit-card ai-history-card'); const photo = button('', () => { showGenerated(record); $('ai-result-save-note').textContent = '这是保存到此浏览器的 AI 试穿记录。'; $('ai-save-result').hidden = true; $('ai-result-panel').scrollIntoView({behavior: 'auto', block: 'start'}); }, 'ai-history-image');
      photo.setAttribute('aria-label', `查看${record.name}`); photo.append(picture(record.image, record.name));
      const actions = el('div', 'card-actions');
      actions.append(button('查看结果', () => photo.click()), button('删除记录', async () => {
        if (!confirm(`删除「${record.name}」的本机试穿记录？衣物和人物照片会保留。`)) return;
        state.generated = state.generated.filter(saved => saved.id !== record.id); originalResults.delete(record.id);
        if (currentGenerated?.id === record.id) { currentGenerated = null; previewMode = 'base'; $('ai-result-panel').hidden = true; renderStudioPreview(); }
        await persist(); renderGeneratedHistory();
      }, 'text-button'));
      card.append(photo, el('h3', '', record.name), el('p', '', `${record.items.length} 件衣物 · ${record.createdAt ? new Date(record.createdAt).toLocaleDateString('zh-CN') : '已保存'}`), actions); return card;
    }));
  }
  async function completeTask(result) {
    if (!aiPending) return;
    if (aiPending.kind === 'recognition') await finishRecognition(result); else await finishTryOn(result);
  }
  async function submitAI(kind, payload, context) {
    aiBusy = true; $('ai-global-error').textContent = ''; $('recognition-error').textContent = '';
    if ($('studio-ai-settings')) $('studio-ai-settings').open = true;
    const requestId = crypto.randomUUID();
    aiPending = {requestId, taskId: requestId, kind, phase: 'running', startedAt: Date.now(), message: '正在提交照片'}; aiContext = context;
    const recoverable = await savePending();
    if (!recoverable) toast('浏览器未能保留本次原图，请保持页面打开，完成后及时保存或下载。');
    renderAI();
    let terminal = false;
    try {
      const response = await fetch(kind === 'recognition' ? '/api/ai/recognize' : '/api/ai/try-on', {method: 'POST', headers: apiHeaders(), credentials: 'omit', body: JSON.stringify({clientId, requestId, ...payload})});
      if (!response.ok) { await readApiJSON(response); return; }
      if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw Error('没有收到任务状态，请查询结果。');
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      async function receive(line) {
        if (!line.trim() || terminal) return;
        const event = JSON.parse(line);
        if (event.taskId && event.taskId !== requestId) throw Error('任务编号与本次提交不一致，请查询本次结果。');
        if (event.type === 'started') { aiPending.message = kind === 'recognition' ? 'AI 正在识别衣物' : 'AI 正在生成试穿图'; await savePending(); renderAI(); }
        else if (event.type === 'completed') { terminal = true; await completeTask(event.result); }
        else if (event.type === 'failed') { terminal = true; const message = apiMessage(event, '这次任务没有完成。'); await clearPending(); throw Error(message); }
      }
      try {
        while (!terminal) {
          const {done, value} = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), {stream: !done});
          if (buffer.length > 45000000) throw Error('结果过大，暂时无法接收。请查询本次任务。');
          const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) await receive(line);
          if (done) { if (buffer.trim()) await receive(buffer); break; }
        }
      } finally { if (terminal) await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!terminal) throw Error('连接已断开，任务可能仍在处理。请查询结果，不要重复提交。');
    } catch (error) {
      const message = error.message || '网络连接中断，请查询本次任务。';
      if ($('studio-ai-settings')) $('studio-ai-settings').open = true;
      $('ai-global-error').textContent = message;
      if (kind === 'recognition') $('recognition-error').textContent = message;
      if (error.apiStatus && aiPending) await clearPending();
      else if (aiPending && aiPending.phase !== 'review') { aiPending.phase = terminal ? 'ready' : 'disconnected'; aiPending.message = message; await savePending(); }
    } finally { aiBusy = false; renderAI(); void checkAI(accessCode, true); }
  }
  async function queryTask() {
    if (aiBusy || !aiPending || !accessCode) return;
    aiBusy = true; $('ai-global-error').textContent = ''; renderAI();
    try {
      const response = await fetch(`/api/ai/tasks/${encodeURIComponent(aiPending.requestId)}?clientId=${encodeURIComponent(clientId)}`, {headers: apiHeaders(), credentials: 'omit', cache: 'no-store'});
      const task = await readApiJSON(response);
      if (task.taskId !== aiPending.requestId) throw Error('返回的任务编号不一致，请稍后再查。');
      if (task.status === 'succeeded') await completeTask(task.result);
      else if (task.status === 'failed') { $('ai-global-error').textContent = apiMessage(task, '这次任务未能完成。'); await clearPending(); }
      else { aiPending.phase = 'disconnected'; aiPending.message = '任务仍在处理，可稍后再次查询。'; await savePending(); }
    } catch (error) { $('ai-global-error').textContent = error.message || '查询失败，请检查网络后再查。'; }
    finally { aiBusy = false; renderAI(); void checkAI(accessCode, true); }
  }
  async function startTryOn() {
    if (aiBusy || aiPending || !aiAllowed('tryOn')) return;
    const model = structuredClone(state.models.find(candidate => candidate.id === modelId));
    const items = selected.map(id => state.items.find(item => item.id === id)).filter(Boolean).map(item => structuredClone(item));
    if (!model || !items.length || items.length > 5) return;
    const prompt = text($('ai-prompt').value, 600), name = text($('outfit-name').value, 60) || `我的 AI 试穿 ${state.generated.length + 1}`;
    aiBusy = true; renderAI(); $('ai-global-error').textContent = '';
    try {
      const modelImage = await compressImage(asset(model.image));
      const submittedItems = await Promise.all(items.map(async item => ({name: item.name, category: item.category, image: await compressImage(asset(item.image))})));
      const context = {name, modelImage, modelId: model.id, modelName: model.name, items: items.map(({id, name, category}) => ({id, name, category})), prompt};
      await submitAI('tryOn', {modelImage, items: submittedItems, prompt}, context);
    } catch (error) { $('ai-global-error').textContent = error.message || '图片准备失败，请重试。'; if ($('studio-ai-settings')) $('studio-ai-settings').open = true; }
    finally { aiBusy = false; renderAI(); }
  }
  async function confirmRecognition(event) {
    event.preventDefault(); if (recognitionSaving || !recognitionPhoto) return;
    const chosen = recognitionCandidates.filter(candidate => candidate.selected);
    if (!chosen.length || chosen.some(candidate => !candidate.name.trim())) { $('recognition-error').textContent = '请选择衣物并填写名称。'; return; }
    const added = chosen.map(candidate => ({id: uid(), name: text(candidate.name, 60), category: candidate.category, color: text(candidate.color, 24), notes: text(candidate.notes, 400), image: candidate.useOriginal ? recognitionPhoto : candidate.image, favorite: false, example: false}));
    const next = {...state, items: [...added, ...state.items]};
    if (next.items.length > 500 || !fitsBudget(next)) { $('recognition-error').textContent = '衣橱容量不足，请先导出备份并整理衣物，再确认入库。'; return; }
    recognitionSaving = true; renderAI();
    state = next; const saved = await persist(); await clearPending();
    recognitionCandidates = []; recognitionPhoto = ''; $('recognition-image-input').value = '';
    $('recognition-dialog').close(); recognitionSaving = false; renderAll();
    if (saved) toast(`已确认保存 ${added.length} 件衣物，可去搭配试衣。`);
  }
  function bindAI() {
    $('ai-access-form').addEventListener('submit', event => { event.preventDefault(); const code = $('ai-code').value.trim() || accessCode; if (!code) { $('ai-global-error').textContent = '请先填写体验码。'; return; } void checkAI(code); });
    $('ai-lock').addEventListener('click', () => { expireAccess(); $('ai-global-error').textContent = ''; renderAI(); });
    $('recognize-item').addEventListener('click', openRecognition); $('ai-review').addEventListener('click', openRecognition);
    $('recognition-image-input').addEventListener('change', async event => {
      const file = event.target.files?.[0]; if (!file) return;
      const version = ++recognitionPhotoVersion; recognitionPreparing = true; $('recognition-error').textContent = ''; renderAI();
      try {
        const photo = await readPhoto(file); if (version !== recognitionPhotoVersion) return;
        recognitionPhoto = photo; preview('recognition-preview', photo);
        if (aiPending?.kind === 'recognition' && aiPending.phase === 'review') { aiContext.image = photo; await prepareCandidates(aiContext.garments, aiContext.edits); await savePending(); }
      } catch (error) { if (version === recognitionPhotoVersion) $('recognition-error').textContent = error.message; }
      finally { if (version === recognitionPhotoVersion) { recognitionPreparing = false; renderAI(); } }
    });
    $('recognition-start').addEventListener('click', () => { if (!aiBusy && !aiPending && recognitionPhoto && aiAllowed('recognition')) { recognitionCandidates = []; void submitAI('recognition', {image: recognitionPhoto}, {image: recognitionPhoto}); } });
    $('recognition-view-source').addEventListener('click', () => { if (recognitionPhoto) showImage(recognitionPhoto, '本次识别原图'); });
    $('recognition-confirm-form').addEventListener('submit', confirmRecognition);
    $('recognition-discard').addEventListener('click', async () => { if (!confirm('放弃这次识别结果？识别已使用的体验次数不会返还。')) return; await clearPending(); recognitionCandidates = []; recognitionPhoto = ''; $('recognition-dialog').close(); renderAI(); });
    $('ai-try-on').addEventListener('click', startTryOn); $('ai-query').addEventListener('click', queryTask);
    $('ai-dismiss').addEventListener('click', async () => { if (aiBusy || !aiPending || !confirm('只移除本机任务记录，云端任务不会取消，已用次数不会返还。结果不明时建议先查询。仍要移除吗？')) return; await clearPending(); renderAI(); });
    $('ai-save-result').addEventListener('click', async () => { if (!currentGenerated) return; $('ai-save-result').disabled = true; try { if (await saveGenerated(currentGenerated)) { if (aiPending?.requestId === currentGenerated.id) await clearPending(); renderAI(); } } finally { $('ai-save-result').disabled = false; } });
    $('recognition-dialog').addEventListener('close', () => { if (aiPending?.phase === 'review') { rememberCandidateEdits(); } });
    window.addEventListener('beforeunload', event => { if (aiBusy && aiPending) { event.preventDefault(); event.returnValue = ''; } });
    aiTick = setInterval(() => { if (aiPending && aiBusy) renderAI(); }, 1000);
  }
  function clearVideo() {
    const video = $('rotation-video'); video.pause(); video.removeAttribute('src'); video.load();
    const studioVideo = $('studio-rotation-video');
    if (studioVideo) { studioVideo.pause(); studioVideo.removeAttribute('src'); studioVideo.load(); studioVideo.hidden = true; }
    videoContext = null;
    if (previewMode === 'rotation') previewMode = originalOutfit() ? 'example' : 'base';
    if (videoURL) URL.revokeObjectURL(videoURL); videoURL = '';
    $('video-input').value = ''; $('video-stage').hidden = true; $('video-empty').hidden = false;
    if ($('studio-video-input')) $('studio-video-input').value = '';
    $('video-scrub').value = 0; $('video-time').textContent = '0:00 / 0:00'; $('video-play').textContent = '播放';
    renderStudioPreview();
  }
  function rotationContext() {
    return [modelId, state.models.find(model => model.id === modelId)?.image, ...[...selected].sort().flatMap(id => [id, state.items.find(item => item.id === id)?.image])];
  }
  function matchingRotation() {
    const context = rotationContext();
    return !!(videoURL && videoContext && context.length === videoContext.length && context.every((value, index) => value === videoContext[index]));
  }
  function renderStudioRotation() {
    const video = $('studio-rotation-video');
    if (!video || !$('studio-rotation-control')) return;
    const ready = matchingRotation() && Number.isFinite(video.duration) && video.duration > 0;
    const visible = ready && previewMode === 'rotation';
    video.hidden = !visible;
    if (!visible) video.pause();
    $('studio-rotation-control').disabled = !ready;
    $('studio-rotation-control').value = ready ? Math.round(video.currentTime / video.duration * 1000) : 0;
    $('studio-rotation-label').textContent = visible ? `转身 ${Math.round(video.currentTime / video.duration * 100)}%` : '360°';
    $('studio-rotation-control').title = ready ? '拖动查看导入视频中的不同角度' : '先导入当前模特的转身视频，即可拖动查看';
    $('studio-video').textContent = ready ? (visible && !video.paused ? '暂停转身' : '播放转身') : '导入转身视频';
    $('studio-video').setAttribute('aria-label', ready ? '播放或暂停当前搭配的转身视频' : '导入当前搭配的转身视频');
    if (visible) {
      $('fitting-model-image').hidden = true;
      $('studio-preview-label').textContent = '转身视频 · 拖动查看';
      $('studio-preview-status').textContent = '左右拖动人物或下方滑条，查看这段视频中的角度。';
    } else if (!ready && !$('studio-rotation-hint')) {
      $('studio-rotation-control').setAttribute('aria-label', '360 转身进度，导入转身视频后可使用');
    }
    if ($('studio-rotation-hint')) $('studio-rotation-hint').textContent = ready ? '左右拖动查看角度' : videoURL ? '这段视频属于导入时的搭配，当前搭配请另行导入' : '导入转身视频后可旋转';
  }
  function importRotationVideo(file) {
    if (!file) return;
    if ((!['video/mp4', 'video/quicktime', 'video/webm'].includes(file.type) && !/\.(mp4|mov|webm)$/i.test(file.name)) || file.size > 100 * 1024 * 1024) { toast('请选择 100 MB 以内的 MP4、MOV 或 WebM 视频。'); return; }
    clearVideo(); videoURL = URL.createObjectURL(file); videoContext = rotationContext();
    $('rotation-video').src = videoURL;
    $('video-label').textContent = `${file.name} · 仅在本次打开中保留`;
    const studioVideo = $('studio-rotation-video');
    if (studioVideo) { studioVideo.src = videoURL; previewMode = 'rotation'; }
  }
  const seconds = value => `${Math.floor((Number.isFinite(value) ? value : 0) / 60)}:${String(Math.floor((Number.isFinite(value) ? value : 0) % 60)).padStart(2, '0')}`;
  function setupVideo() {
    const video = $('rotation-video'); let drag = null;
    $('video-input').addEventListener('change', () => {
      importRotationVideo($('video-input').files?.[0]);
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
  function setupStudioRotation() {
    const video = $('studio-rotation-video'); if (!video) return;
    let drag = null;
    $('studio-video-input').addEventListener('change', event => importRotationVideo(event.target.files?.[0]));
    video.addEventListener('loadedmetadata', () => { if (Number.isFinite(video.duration) && video.duration > 0) renderStudioPreview(); });
    for (const event of ['timeupdate','play','pause','ended']) video.addEventListener(event, renderStudioRotation);
    video.addEventListener('error', () => { if (videoURL) { clearVideo(); toast('这段视频暂时无法播放，请换一段 H.264 编码的 MP4。'); } });
    $('studio-rotation-control').addEventListener('input', event => {
      if (!matchingRotation() || !video.duration) return;
      previewMode = 'rotation'; video.pause(); video.currentTime = Number(event.target.value) / 1000 * video.duration; renderStudioPreview();
    });
    video.style.touchAction = 'pan-y';
    video.addEventListener('pointerdown', event => { if (event.button !== 0 || !matchingRotation() || !video.duration) return; video.pause(); drag = {x:event.clientX,t:video.currentTime}; video.setPointerCapture?.(event.pointerId); });
    video.addEventListener('pointermove', event => { if (drag) video.currentTime = Math.max(0, Math.min(video.duration, drag.t + (event.clientX - drag.x) / Math.max(video.clientWidth,1) * video.duration)); });
    for (const event of ['pointerup','pointercancel','lostpointercapture']) video.addEventListener(event, () => { drag = null; });
    window.addEventListener('pagehide', () => video.pause());
  }
  function bind() {
    document.querySelectorAll('a[data-page],button[data-page]').forEach(node => node.addEventListener('click', () => navigate(node.dataset.page)));
    document.querySelectorAll('[data-filter]').forEach(node => node.addEventListener('click', () => { filter = node.dataset.filter; renderWardrobe(); }));
    document.querySelectorAll('[data-close-dialog]').forEach(node => node.addEventListener('click', () => node.closest('dialog').close()));
    $('search-input').addEventListener('input', renderWardrobe);
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
      state.models.push(model); modelId = model.id; $('model-dialog').close(); renderAll(); if (await persist()) toast('模特已添加，可前往搭配工作台搭配。');
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
      $('studio-records').open = true;
      previewMode = 'example'; renderStudioPreview();
      $('result-before').src = asset(seed.models[0].image); $('result-before').alt = '换装前：中国女生全身参考图';
      $('result-after').src = asset(seed.example.result); $('result-after').alt = '换装后：黄色 Polo、米白外套、蓝色阔腿裤、黑白运动鞋与黑棕托特包';
      $('result-description').textContent = seed.example.description;
      $('download-result').href = asset(seed.example.result); $('download-result').download = '爱衣橱-五件套实测试穿.jpg';
      $('result-panel').hidden = false;
    });
    $('view-collage').addEventListener('click', () => showImage(seed.example.collage, '实测搭配原图'));
    $('export-data').addEventListener('click', () => { downloadBlob(new Blob([JSON.stringify(state)], { type: 'application/json' }), `爱衣橱备份-${new Date().toISOString().slice(0, 10)}.json`); toast('备份已导出。可用“导入备份”恢复到当前网页。'); });
    $('import-data').addEventListener('change', async event => { try { await importBackup(event.target.files?.[0]); } catch (e) { toast(e instanceof SyntaxError ? '文件不是有效的 JSON 备份。' : e.message); } finally { event.target.value = ''; } });
    setupVideo();
    bindStudio();
  }
  function bindStudio() {
    setupStudioRotation();
    $('studio-search').addEventListener('input', renderFitting);
    document.querySelectorAll('[data-studio-filter]').forEach(node => node.addEventListener('click', () => { studioFilter = node.dataset.studioFilter; renderFitting(); }));
    $('studio-clear').addEventListener('click', () => { selected = []; renderFitting(); });
    $('studio-recognize').addEventListener('click', openRecognition);
    $('studio-add').addEventListener('click', () => openItem());
    $('studio-manage-models').addEventListener('click', () => navigate('models'));
    $('studio-video').addEventListener('click', async () => {
      const video = $('studio-rotation-video');
      if (!matchingRotation() || !video?.duration) { $('studio-video-input').click(); return; }
      const pause = previewMode === 'rotation' && !video.paused;
      previewMode = 'rotation'; renderStudioPreview();
      try { if (pause) video.pause(); else { $('rotation-video').pause(); await video.play(); } } catch (_) { toast('视频暂时无法播放，请重新导入。'); }
    });
    $('studio-browse-all')?.addEventListener('click', () => { studioFilter = 'all'; $('studio-search').value = ''; renderFitting(); });
    $('studio-history').addEventListener('click', () => { navigate('fitting', false); $('studio-records').open = true; (state.generated.length ? $('ai-history-section') : $('saved-outfits')).scrollIntoView({block:'start',behavior:'auto'}); });
    $('studio-open-ai').addEventListener('click', () => { $('studio-ai-settings').open = true; $('ai-code').focus(); });
    $('studio-preview-base').addEventListener('click', () => { previewMode = 'base'; renderStudioPreview(); });
    $('studio-preview-example').addEventListener('click', () => { if (originalOutfit()) { previewMode = 'example'; renderStudioPreview(); } });
    $('studio-preview-latest').addEventListener('click', () => { const record = currentGenerated || state.generated[0]; if (record) showGenerated(record); });
    $('studio-preview-open').addEventListener('click', () => { const image = $('fitting-model-image'); if (!image.hidden && image.src) showImage(image.dataset.original || image.src, '原始试穿图片'); });
    window.addEventListener('hashchange', () => { const page = location.hash.slice(1); if (['fitting','wardrobe','models','about'].includes(page)) navigate(page, false); });
  }
  async function init() {
    await openStorage();
    clientId = makeClientId(); try { accessCode = sessionStorage.getItem(AI_CODE_KEY) || ''; } catch (_) {}
    await restorePending(); bind(); bindAI(); renderAll(); navigate(location.hash.slice(1) || 'fitting', false); window.appReady = true;
    if (accessCode) void checkAI(accessCode, true);
  }
  init().catch(() => { status('页面未能初始化，请重新打开文件'); });
})();
