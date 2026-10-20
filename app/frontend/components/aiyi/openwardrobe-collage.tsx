'use client';

import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { ArrowDownToLine, ArrowUpToLine, Check, Grip, Layers, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import styles from './openwardrobe-collage.module.css';

export type CollageLayout = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  elements: Array<{ id: string; itemId: string; x: number; y: number; scale: number; rotation: number; z: number }>;
};

type CollageItem = { id: string; name: string | null; type: string; image_url: string; thumbnail_url?: string };
type Element = CollageLayout['elements'][number];
type Props = {
  items: CollageItem[];
  initialLayout?: CollageLayout;
  onSave: (layout: CollageLayout) => void | Promise<void>;
  onCancel: () => void;
};

const positions = [
  { x: 30, y: 28 }, { x: 68, y: 51 }, { x: 29, y: 74 },
  { x: 74, y: 83 }, { x: 76, y: 22 }, { x: 28, y: 52 },
];
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const uid = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID() : `collage-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const defaultScale = (type: string) => ['shoe', 'shoes', 'bag', 'accessory', 'accessories'].includes(type) ? 0.7 : 1;

function firstElements(items: CollageItem[]): Element[] {
  const kinds = new Set<string>();
  return items.filter(item => {
    if (kinds.has(item.type)) return false;
    kinds.add(item.type);
    return true;
  }).slice(0, 4).map((item, index) => ({
    id: uid(), itemId: item.id, ...positions[index], scale: defaultScale(item.type), rotation: 0, z: index,
  }));
}

export function CollageEditor({ items, initialLayout, onSave, onCancel }: Props) {
  const itemMap = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
  const [layoutId] = useState(() => initialLayout?.id || uid());
  const [createdAt] = useState(() => initialLayout?.createdAt || new Date().toISOString());
  const [elements, setElements] = useState<Element[]>(() => initialLayout
    ? initialLayout.elements.filter(element => items.some(item => item.id === element.itemId)).map(element => ({ ...element }))
    : firstElements(items));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState(initialLayout?.name || '我的新搭配');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [message, setMessage] = useState('拖动衣物调整位置，点击衣物编辑大小和角度。');
  const initialState = useRef(JSON.stringify({ name, elements }));
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; pointerId: number; startX: number; startY: number; x: number; y: number; width: number; height: number } | null>(null);
  const selected = elements.find(element => element.id === selectedId);
  const selectedItem = selected ? itemMap.get(selected.itemId) : null;
  const library = items.filter(item => `${item.name || ''} ${item.type}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selectedItemIds = new Set(elements.map(element => element.itemId));

  function change(id: string, patch: Partial<Element>) {
    setElements(current => current.map(element => element.id === id ? { ...element, ...patch } : element));
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, element: Element) {
    if (event.button !== 0) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(element.id);
    drag.current = { id: element.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: element.x, y: element.y, width: rect.width, height: rect.height };
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    change(current.id, {
      x: clamp(current.x + (event.clientX - current.startX) / current.width * 100, 0, 100),
      y: clamp(current.y + (event.clientY - current.startY) / current.height * 100, 0, 100),
    });
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function keyboardMove(event: KeyboardEvent<HTMLButtonElement>, element: Element) {
    const step = event.shiftKey ? 5 : 1;
    const directions: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (directions[event.key]) {
      event.preventDefault();
      setSelectedId(element.id);
      change(element.id, { x: clamp(element.x + directions[event.key][0], 0, 100), y: clamp(element.y + directions[event.key][1], 0, 100) });
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove(element.id);
    }
  }

  function add(item: CollageItem) {
    if (selectedItemIds.has(item.id)) {
      setSelectedId(elements.find(element => element.itemId === item.id)?.id || null);
      return;
    }
    const id = uid();
    setElements(current => [...current, { id, itemId: item.id, ...positions[current.length % positions.length], scale: defaultScale(item.type), rotation: 0, z: Math.max(-1, ...current.map(element => element.z)) + 1 }]);
    setSelectedId(id);
    setMessage(`已加入${item.name || '衣物'}，可以拖动调整。`);
  }

  function remove(id: string) {
    setElements(current => current.filter(element => element.id !== id));
    setSelectedId(current => current === id ? null : current);
    setMessage('衣物已从画布移除，衣橱中的原衣物仍保留。');
  }

  function moveLayer(direction: -1 | 1) {
    if (!selected) return;
    const ordered = [...elements].sort((a, b) => a.z - b.z);
    const index = ordered.findIndex(element => element.id === selected.id);
    const next = ordered[index + direction];
    if (!next) return;
    [ordered[index], ordered[index + direction]] = [ordered[index + direction], ordered[index]];
    setElements(ordered.map((element, z) => ({ ...element, z })));
  }

  function arrange() {
    setElements(current => current.map((element, index) => ({ ...element, ...positions[index % positions.length], scale: defaultScale(itemMap.get(element.itemId)?.type || ''), rotation: 0, z: index })));
    setMessage('已重新排列。你可以继续拖动调整。');
  }

  function cancel() {
    if (saving) return;
    const hasChanges = JSON.stringify({ name, elements }) !== initialState.current;
    if (hasChanges && !window.confirm('搭配还有未保存的调整，确定放弃这些调整吗？')) return;
    onCancel();
  }

  async function save() {
    if (saving || !elements.length) return;
    const now = new Date().toISOString();
    setSaving(true);
    setSaveError('');
    try {
      await onSave({ id: layoutId, name: name.trim() || '未命名搭配', createdAt, updatedAt: now, elements: elements.map(element => ({ ...element })) });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  return <div className={styles.editor} aria-busy={saving}>
    <div className={styles.heading}>
      <div><span className={styles.eyebrow}>OUTFIT STUDIO</span><h2>{initialLayout ? '编辑平铺搭配' : '创作一套搭配'}</h2><p>把喜欢的衣物放在一起，找到今天的灵感。</p></div>
      <button type="button" className={styles.close} onClick={cancel} disabled={saving} aria-label="关闭平铺编辑器"><X size={20} /></button>
    </div>
    <div className={styles.workspace}>
      <aside className={styles.library} aria-label="编辑器衣物列表">
        <div className={styles.panelHeading}><h3>从衣橱中选择</h3><span>{items.length} 件</span></div>
        <input className={styles.search} value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索搭配衣物" placeholder="搜索衣物" />
        <div className={styles.itemGrid}>
          {library.map(item => <button key={item.id} type="button" title={item.name || '未命名衣物'} className={`${styles.libraryItem} ${selectedItemIds.has(item.id) ? styles.added : ''}`} onClick={() => add(item)} disabled={saving} aria-label={`${selectedItemIds.has(item.id) ? '选中' : '添加'}${item.name || '衣物'}`}>
            <span className={styles.itemPhoto}><img src={item.thumbnail_url || item.image_url} alt="" draggable={false} /><span className={styles.addBadge}>{selectedItemIds.has(item.id) ? <Check size={13} /> : <Plus size={13} />}</span></span>
            <span className={styles.itemName}>{item.name || '未命名衣物'}</span>
          </button>)}
        </div>
        {library.length === 0 && <p className={styles.emptyLibrary}>{items.length ? '没有找到这件衣物。' : '先在衣橱中添加衣物，再来创作搭配。'}</p>}
      </aside>
      <section className={styles.stage} aria-label="平铺搭配画布区">
        <div className={styles.stageToolbar}><span><Grip size={14} /> {elements.length} 件衣物</span><div><button type="button" onClick={arrange} disabled={!elements.length || saving}><RotateCcw size={14} />自动排列</button><button type="button" onClick={() => { setElements([]); setSelectedId(null); setMessage('画布已清空，可以从衣橱重新添加。'); }} disabled={!elements.length || saving}>清空</button></div></div>
        <div ref={canvasRef} className={styles.canvas} onPointerDown={event => { if (event.target === event.currentTarget) setSelectedId(null); }}>
          {!elements.length && <div className={styles.emptyCanvas}><Layers size={30} strokeWidth={1} /><p>你的搭配，从一件衣物开始</p><span>点击衣橱中的衣物添加到画布</span></div>}
          {elements.map(element => {
            const item = itemMap.get(element.itemId);
            if (!item) return null;
            return <button key={element.id} type="button" disabled={saving} className={`${styles.canvasItem} ${selectedId === element.id ? styles.selected : ''}`} style={{ left: `${element.x}%`, top: `${element.y}%`, zIndex: element.z + 1, transform: `translate(-50%, -50%) rotate(${element.rotation}deg) scale(${element.scale})` }} onPointerDown={event => startDrag(event, element)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { drag.current = null; }} onClick={() => setSelectedId(element.id)} onFocus={() => setSelectedId(element.id)} onKeyDown={event => keyboardMove(event, element)} aria-label={`移动${item.name || '衣物'}`} aria-pressed={selectedId === element.id}>
              <img src={item.image_url} alt={item.name || '衣物'} draggable={false} />
              {selectedId === element.id && <><i className={styles.cornerTopLeft} /><i className={styles.cornerTopRight} /><i className={styles.cornerBottomLeft} /><i className={styles.cornerBottomRight} /></>}
            </button>;
          })}
          <span className={styles.canvasBrand} aria-hidden="true">爱衣橱 · MY OUTFIT</span>
        </div>
        <p className={styles.hint} role="status" aria-live="polite">{message}</p>
      </section>
      <aside className={styles.controls} aria-label="搭配编辑设置">
        <label className={styles.nameLabel}>搭配名称<input value={name} disabled={saving} onChange={event => setName(event.target.value)} maxLength={60} placeholder="给这套搭配起个名字" /></label>
        <div className={styles.selectionHeading}><h3>{selectedItem ? selectedItem.name || '未命名衣物' : '编辑衣物'}</h3><p>{selected ? '拖动调整位置，也可以使用方向键。' : '点击画布上的衣物，调整大小和角度。'}</p></div>
        <fieldset className={styles.adjustments} disabled={!selected || saving}>
          <label><span>大小<b>{selected ? Math.round(selected.scale * 100) : 100}%</b></span><input type="range" aria-label="衣物大小" min="0.3" max="2.5" step="0.05" value={selected?.scale ?? 1} onChange={event => selected && change(selected.id, { scale: Number(event.target.value) })} /></label>
          <label><span>旋转<b>{selected ? Math.round(selected.rotation) : 0}°</b></span><input type="range" aria-label="衣物旋转" min="-180" max="180" step="1" value={selected?.rotation ?? 0} onChange={event => selected && change(selected.id, { rotation: Number(event.target.value) })} /></label>
          <div className={styles.layerButtons}><button type="button" onClick={() => moveLayer(1)} aria-label="衣物向前一层"><ArrowUpToLine size={17} />向前一层</button><button type="button" onClick={() => moveLayer(-1)} aria-label="衣物向后一层"><ArrowDownToLine size={17} />向后一层</button></div>
          <button type="button" className={styles.remove} onClick={() => selected && remove(selected.id)}><Trash2 size={16} />移出画布</button>
        </fieldset>
        <div className={styles.localNotice}><span>平铺布局 · 本机保存</span><p>搭配单品保存到衣橱服务；平铺位置保存在本机浏览器。换浏览器或清理网站数据后，位置不会同步。</p></div>
        {saveError && <p className={styles.saveError} role="alert">{saveError}</p>}
        <div className={styles.actions}><button type="button" className={styles.save} onClick={save} disabled={!elements.length || saving}><Check size={17} />{saving ? '正在保存…' : '保存搭配'}</button><button type="button" className={styles.cancel} onClick={cancel} disabled={saving}>取消</button></div>
      </aside>
    </div>
  </div>;
}
