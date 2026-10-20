'use client';
import { useEffect, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Upload } from 'lucide-react';
import styles from './workbench.module.css';
import { garmentTypes as types, garmentColors as colors } from './wardrobe-options';
export type Item = { id: string; name: string | null; type: string; primary_color: string | null; favorite: boolean; notes: string | null; image_url: string; thumbnail_url?: string; };
function failureMessage(error: unknown) {return error instanceof Error ? error.message : '保存没有完成，请重试。';}
export function ItemForm({item, request, onSaved}: {item: Item | null; request: <T>(path: string, init?: RequestInit) => Promise<T>; onSaved: () => void}) {
  const [name, setName] = useState(item?.name || '');
  const [type, setType] = useState(item?.type || 't-shirt');
  const [color, setColor] = useState(item?.primary_color || '');
  const [notes, setNotes] = useState(item?.notes || '');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!file) {setPreview(''); return;}
    const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url);
  }, [file]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!item && !file) {setError('请先选择一张衣物图片。'); return;}
    setBusy(true);
    try {
      if (item) await request(`/items/${item.id}`, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: name.trim(), type, primary_color: color || null, colors: color ? [color] : [], notes})});
      else {
        const data = new FormData(); data.set('image', file!); data.set('name', name.trim()); data.set('type', type); data.set('skip_ai', 'true'); data.set('notes', notes);
        if (color) {data.set('colors', color); data.set('primary_color', color);}
        await request('/items', {method: 'POST', body: data});
      }
      onSaved();
    } catch (err) {setError(failureMessage(err));}
    finally {setBusy(false);}
  }
  return <form onSubmit={submit} className={styles.form}>
    {!item ? <label className={styles.upload}>{preview ? <img src={preview} alt="待上传衣物预览"/> : <><Upload size={26}/><strong>选择衣物照片</strong><span>JPG、PNG 或 WebP，最大 20 MB</span></>}<input type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择衣物照片" disabled={busy} onChange={event => {
      const next = event.target.files?.[0];
      if (!next) return;
      if (!['image/jpeg','image/png','image/webp'].includes(next.type) || next.size > 20 * 1024 * 1024) {setError('请选择不超过 20 MB 的 JPG、PNG 或 WebP 图片。'); event.target.value = ''; return;}
      setFile(next); setError('');
      if (!name) setName(next.name.replace(/\.[^.]+$/, '').slice(0,100));
    }}/>{preview && <span>点击图片重新选择</span>}</label> : <img className={styles.editPreview} src={item.image_url} alt={item.name || '衣物'}/>}
    <label className={styles.field}>衣物名称<input required maxLength={100} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="例如：白色纯棉 T 恤"/></label>
    <div className={styles.fieldRow}><label className={styles.field}>类别<select value={type} disabled={busy} onChange={event => setType(event.target.value)}>{types.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className={styles.field}>主色<select value={color} disabled={busy} onChange={event => setColor(event.target.value)}><option value="">暂不填写</option>{colors.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <label className={styles.field}>备注（选填）<textarea maxLength={1000} value={notes} disabled={busy} onChange={event => setNotes(event.target.value)} placeholder="例如：版型偏宽松，适合周末穿" rows={2}/></label>
    <p className={styles.small}>此表单为手动入库，图片只保存到本机。如需自动识别，请使用衣橱页的 AI 识别入库。</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.dialogActions}><Dialog.Close className={styles.secondary} disabled={busy}>取消</Dialog.Close><button className={styles.primary} type="submit" disabled={busy || !name.trim()}><Check size={16}/>{busy ? '正在保存…' : '保存衣物'}</button></div>
  </form>;
}
