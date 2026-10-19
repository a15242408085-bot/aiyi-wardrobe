'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { signIn, signOut, useSession } from 'next-auth/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Shirt, Layers3, ScanLine, UserRound, Settings2, Plus, Search, ArrowRight, Check, X, Heart, Pencil, Trash2, Upload, HelpCircle, RefreshCw, FolderOpen, LogOut, ChevronRight, Circle, CheckCircle2 } from 'lucide-react';
import styles from './workbench.module.css';
import { AISettings, FittingPanel, RecognitionPanel } from './ai-workflows';
import { ModelsPanel } from './model-rotation';
import { CatalogStudio } from './catalog-studio';
import { garmentTypes as types, garmentColors as colors, garmentTypeLabel as typeLabel } from './wardrobe-options';

export type Section = 'wardrobe' | 'outfits' | 'fitting' | 'models' | 'body' | 'settings';
type Item = { id: string; name: string | null; type: string; primary_color: string | null; favorite: boolean; notes: string | null; image_url: string; thumbnail_url?: string; };
type Outfit = { id: string; name: string | null; occasion: string; items: Item[]; };
type Capabilities = { ai: { vision: boolean; text: boolean } };
const navigation = [
  { id: 'wardrobe', label: '我的衣橱', icon: Shirt },
  { id: 'outfits', label: '搭配工作台', icon: Layers3 },
  { id: 'fitting', label: '试衣间', icon: ScanLine },
  { id: 'models', label: '模特与 360', icon: UserRound },
  { id: 'body', label: '我的身材', icon: UserRound },
  { id: 'settings', label: '功能与设置', icon: Settings2 },
] as const;
const tops = new Set(['top', 't-shirt', 'shirt', 'blouse', 'sweater', 'hoodie', 'tank-top', 'polo']);
const bottoms = new Set(['pants', 'jeans', 'shorts', 'skirt', 'trousers']);
const colorLabel = (color: string | null) => colors.find(([value]) => value === color)?.[1] || color || '颜色未填写';

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/duplicate/i.test(message)) return '这张图片已经在衣橱里了，请查看已有衣物。';
  if (/fetch|backend|connect/i.test(message)) return '暂时连接不到本地服务，请检查服务状态后重试。';
  return message || '操作没有完成，请重试。';
}

export function Workbench({ section }: { section: Section }) {
  const { data: session, status } = useSession();
  const token = session?.accessToken;
  const queryClient = useQueryClient();
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [editor, setEditor] = useState<Item | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const [notice, setNotice] = useState('');
  const [selectedTop, setSelectedTop] = useState('');
  const [selectedBottom, setSelectedBottom] = useState('');
  const [outfitName, setOutfitName] = useState('');
  const [catalogItemId, setCatalogItemId] = useState('');

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`/api/v1${path}`, { ...init, headers });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const detail = data.detail;
      throw new Error(typeof detail === 'string' ? detail : detail?.message || `请求失败（${response.status}）`);
    }
    return response.status === 204 ? undefined as T : response.json();
  }

  const health = useQuery({ queryKey: ['aiyi', 'health'], queryFn: () => request<{status: string; checks: {database: string}}>('/health/ready'), retry: false, refetchInterval: 15000 });
  const capabilities = useQuery({ queryKey: ['aiyi', 'capabilities'], queryFn: () => request<Capabilities>('/capabilities'), retry: false });
  const items = useQuery({ queryKey: ['aiyi', 'items', session?.user?.id], queryFn: async () => {
    const loaded: Item[] = [];
    let page = 1;
    let total = 0;
    let hasMore = true;
    while (hasMore) {
      const result = await request<{items: Item[]; total: number; has_more: boolean}>(`/items?page_size=100&page=${page}`);
      loaded.push(...result.items); total = result.total; hasMore = result.has_more; page += 1;
    }
    return {items: loaded, total};
  }, enabled: !!token, retry: false });
  const outfits = useQuery({ queryKey: ['aiyi', 'outfits', session?.user?.id], queryFn: () => request<{outfits: Outfit[]; total: number}>('/outfits?page_size=100'), enabled: !!token && section === 'outfits', retry: false });
  const allItems = items.data?.items || [];
  const upper = allItems.filter(item => tops.has(item.type));
  const lower = allItems.filter(item => bottoms.has(item.type));
  const visible = allItems.filter(item => {
    const categoryMatch = filter === 'all' || (filter === 'tops' && tops.has(item.type)) || (filter === 'bottoms' && bottoms.has(item.type)) || (filter === 'favorite' && item.favorite) || (filter === 'other' && !tops.has(item.type) && !bottoms.has(item.type));
    return categoryMatch && `${item.name || ''} ${typeLabel(item.type)} ${colorLabel(item.primary_color)}`.toLowerCase().includes(search.toLowerCase());
  });
  const chosen = [selectedTop, selectedBottom].map(id => allItems.find(item => item.id === id));
  const online = health.data?.status === 'healthy';
  const title = navigation.find(item => item.id === section)?.label;

  useEffect(() => { setNotice(''); }, [section]);
  useEffect(() => {
    if (items.data) {
      if (selectedTop && !items.data.items.some(item => item.id === selectedTop)) setSelectedTop('');
      if (selectedBottom && !items.data.items.some(item => item.id === selectedBottom)) setSelectedBottom('');
    }
  }, [items.data, selectedTop, selectedBottom]);

  const update = useMutation({
    mutationFn: ({id, data}: {id: string; data: Partial<Item>}) => request<Item>(`/items/${id}`, { method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) }),
    onSuccess: () => { queryClient.invalidateQueries({queryKey: ['aiyi', 'items']}); setNotice('已保存衣物信息。'); },
    onError: error => setNotice(failureMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => request(`/items/${id}`, {method: 'DELETE'}),
    onSuccess: () => { setDeleting(null); queryClient.invalidateQueries({queryKey: ['aiyi']}); setNotice('衣物已删除。'); },
    onError: error => setNotice(failureMessage(error)),
  });
  const saveOutfit = useMutation({
    mutationFn: () => request('/outfits/studio', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({items: chosen.filter(Boolean).map(item => item!.id), occasion: 'casual', name: outfitName.trim() || '我的日常搭配', mark_worn: false})}),
    onSuccess: () => {queryClient.invalidateQueries({queryKey: ['aiyi', 'outfits']}); setNotice('搭配已保存，可以在下方查看。'); setOutfitName('');},
    onError: error => setNotice(failureMessage(error)),
  });

  async function enterWorkspace() {
    setLoginBusy(true); setLoginError('');
    try {
      const result = await signIn('dev-credentials', { email: 'local@aiyichu.local', name: '本地用户', redirect: false });
      if (result?.error) setLoginError('本地登录失败，请先启动服务后重试。');
    } catch { setLoginError('无法进入本地工作区，请重试。'); }
    finally { setLoginBusy(false); }
  }

  return <div className={styles.app}>
    <aside className={styles.sidebar}>
      <Link className={styles.brand} href="/workspace/wardrobe"><span className={styles.brandIcon}><Shirt size={23}/></span><span>爱衣橱<small>功能工作台</small></span></Link>
      <div className={styles.navLabel}>我的空间</div>
      <nav aria-label="主导航">{navigation.map(({id, label, icon: Icon}) => <Link key={id} href={`/workspace/${id}`} aria-current={section === id ? 'page' : undefined} className={`${styles.navItem} ${section === id ? styles.navActive : ''}`}><Icon size={19}/><span>{label}</span>{section === id && <ChevronRight size={15}/>}</Link>)}</nav>
      <div className={styles.sidebarBottom}><span className={styles.localPill}>本地开发版</span><p>先跑通功能<br/>再打磨每一次穿搭</p><div className={styles.connection}><span className={online ? styles.greenDot : styles.grayDot}/>{online ? '本地服务已连接' : '等待本地服务'}</div>{token && <button className={styles.logout} onClick={() => signOut({callbackUrl: '/workspace/wardrobe'})}><LogOut size={14}/>退出工作区</button>}</div>
    </aside>
    <main className={styles.main}>
      <header className={styles.topbar}><span>爱衣橱 <ChevronRight size={13}/> {title}</span><span className={styles.version}>功能工作台 v0.3</span></header>
      <div className={styles.content}>
        <div className={styles.pageHeading}><div><div className={styles.eyebrow}>YOUR EVERYDAY WARDROBE</div><h1>{title}</h1><p>{section === 'wardrobe' ? '从你已有的每一件衣服开始。' : section === 'outfits' ? '把真实衣物组合在一起，找到今天想穿的一套。' : section === 'fitting' ? '让选中的搭配，有一个直观的上身参考。' : section === 'models' ? '保存真实模特照片，查看可转动的穿搭效果。' : section === 'body' ? '建立一张接近自己体型的专属模特底图。' : '查看哪些功能已经可用，以及下一步要接通什么。'}</p></div>{section === 'wardrobe' && token && <button className={styles.primary} onClick={() => setEditor('new')}><Plus size={17}/>手动添加</button>}</div>

        {notice && <div role="status" className={styles.notice}>{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={16}/></button></div>}
        {(!token || status === 'loading') ? <section className={styles.welcome}>
          <div className={styles.welcomeIcon}><FolderOpen size={32}/></div><h2>开始整理你的第一件衣物</h2><p>这是本机上的功能验证空间。衣物与搭配会实际保存，刷新页面后仍可查看。</p><p className={styles.small}>目前使用本地开发账户，尚未接入正式注册登录。</p>
          <button className={styles.primary} disabled={status === 'loading' || loginBusy || !online} onClick={enterWorkspace}>{loginBusy ? '正在进入…' : status === 'loading' ? '正在加载…' : '进入本地工作区'}<ArrowRight size={16}/></button>
          {(!online || loginError || session?.syncError) && <p role="alert" className={styles.error}>{loginError || (session?.syncError ? '账户连接失败，请重试本地登录。' : '本地服务尚未就绪，连接后即可进入。')}</p>}
        </section> : <>
        {section === 'wardrobe' && <>
          <div className={styles.summary}><div><strong>{items.data?.total ?? '—'}</strong><span>全部衣物</span></div><div><strong>{upper.length}</strong><span>上衣</span></div><div><strong>{lower.length}</strong><span>下装</span></div><div><strong>{allItems.filter(item => item.favorite).length}</strong><span>我的喜欢</span></div><p><CheckCircle2 size={17}/>支持 AI 识别后确认入库<span>也可手动填写保存</span></p></div>
          <RecognitionPanel request={request} userKey={session?.user?.id || 'local'}/>
          <div className={styles.toolbar}><div className={styles.filters}>{[['all','全部'],['tops','上衣'],['bottoms','下装'],['other','其他'],['favorite','喜欢']].map(([id,label]) => <button key={id} aria-pressed={filter === id} className={filter === id ? styles.filterActive : ''} onClick={() => setFilter(id)}>{label}</button>)}</div><label className={styles.search}><Search size={16}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索名称、类别、颜色" aria-label="搜索衣物"/></label></div>
          {items.isLoading ? <p role="status" className={styles.loading}>正在读取你的衣橱…</p> : items.isError ? <ErrorPanel message={failureMessage(items.error)} retry={() => items.refetch()}/> : visible.length ? <div className={styles.grid}>{visible.map(item => <article key={item.id} className={styles.itemCard}>
            <div className={styles.itemImage}><img src={item.thumbnail_url || item.image_url} alt={item.name || typeLabel(item.type)} loading="lazy"/><button disabled={update.isPending} className={`${styles.favorite} ${item.favorite ? styles.favorited : ''}`} onClick={() => update.mutate({id: item.id, data: {favorite: !item.favorite}})} aria-label={`${item.favorite ? '取消喜欢' : '喜欢'}${item.name || '衣物'}`}><Heart size={17} fill={item.favorite ? 'currentColor' : 'none'}/></button></div>
            <div className={styles.itemInfo}><h2>{item.name || '未命名衣物'}</h2><p>{typeLabel(item.type)}<span>·</span>{colorLabel(item.primary_color)}</p><div className={styles.itemActions}><button onClick={() => setEditor(item)}><Pencil size={13}/>编辑</button><button onClick={() => {setCatalogItemId(item.id); document.getElementById('catalog-studio')?.scrollIntoView({block: 'start'});}}>生成单品图</button><button onClick={() => setDeleting(item)} aria-label={`删除${item.name || '衣物'}`}><Trash2 size={13}/>删除</button></div></div>
          </article>)}</div> : <Empty icon={Shirt} title={allItems.length ? '没有找到对应衣物' : '衣橱里还没有衣服'} text={allItems.length ? '试试其他分类，或换一个搜索关键词。' : '上传一张清晰的单件衣物照片，填好名称和类别，就能保存到自己的衣橱。'} action={!allItems.length ? <button className={styles.primary} onClick={() => setEditor('new')}><Plus size={16}/>添加第一件衣物</button> : undefined}/>}
          <div className={styles.helpLine}><HelpCircle size={15}/>先录入几件常穿的上衣和裤子，再去搭配工作台组合。</div>
          <CatalogStudio request={request} userKey={session?.user?.id || 'local'} items={allItems} selectedItemId={catalogItemId}/>
        </>}

        {section === 'outfits' && <>
          <div className={styles.inlineNote}><HelpCircle size={17}/><div><strong>当前可以手动搭配并保存</strong><p>AI 推荐尚未启用。先用自己上传的衣物，验证组合与保存流程。</p></div></div>
          {items.isLoading ? <p className={styles.loading}>正在读取衣物…</p> : items.isError ? <ErrorPanel message={failureMessage(items.error)} retry={() => items.refetch()}/> : <div className={styles.builder}>
            <div><h2>组合一套搭配</h2><label className={styles.field}>选择上衣<select value={selectedTop} onChange={event => setSelectedTop(event.target.value)}><option value="">{upper.length ? '请选择一件上衣' : '请先添加上衣'}</option>{upper.map(item => <option value={item.id} key={item.id}>{item.name || typeLabel(item.type)}</option>)}</select></label><label className={styles.field}>选择下装<select value={selectedBottom} onChange={event => setSelectedBottom(event.target.value)}><option value="">{lower.length ? '请选择一件下装' : '请先添加裤子或半裙'}</option>{lower.map(item => <option value={item.id} key={item.id}>{item.name || typeLabel(item.type)}</option>)}</select></label><label className={styles.field}>搭配名称<input maxLength={100} value={outfitName} onChange={event => setOutfitName(event.target.value)} placeholder="例如：周末的舒服搭配"/></label><button className={styles.primary} disabled={!chosen.every(Boolean) || saveOutfit.isPending} onClick={() => saveOutfit.mutate()}><Check size={16}/>{saveOutfit.isPending ? '正在保存…' : '保存这套搭配'}</button></div>
            <div className={styles.collage}><span className={styles.collageLabel}>单品组合预览</span><div>{chosen.map((item,index) => <div className={styles.slot} key={index}>{item ? <><img src={item.image_url} alt={item.name || typeLabel(item.type)}/><span>{item.name || typeLabel(item.type)}</span></> : <><Shirt size={32}/><span>{index ? '选择下装' : '选择上衣'}</span></>}</div>)}</div><p>展示衣物原图，尚未生成真人上身效果。</p></div>
          </div>}
          <h2 className={styles.sectionHeading}>已保存的搭配 <span>{outfits.data?.total ?? 0}</span></h2>
          {outfits.isError ? <ErrorPanel message={failureMessage(outfits.error)} retry={() => outfits.refetch()}/> : outfits.isLoading ? <p className={styles.loading}>正在读取搭配…</p> : !outfits.data?.outfits.length ? <p className={styles.small}>保存第一套搭配后，会显示在这里。</p> : <div className={styles.outfitGrid}>{outfits.data.outfits.map(outfit => <article className={styles.savedOutfit} key={outfit.id}><div>{outfit.items.map(item => <img key={item.id} src={item.thumbnail_url || item.image_url} alt={item.name || typeLabel(item.type)}/>)}</div><h3>{outfit.name || '我的搭配'}</h3><p>{outfit.items.map(item => item.name || typeLabel(item.type)).join(' ＋ ')}</p><span className={styles.softLabel}>手动搭配</span></article>)}</div>}
        </>}

        {section === 'fitting' && <Suspense fallback={<p className={styles.small}>正在读取试衣间…</p>}><FittingPanel request={request} userKey={session?.user?.id || 'local'} items={allItems} itemsLoading={items.isLoading} itemsError={items.isError ? failureMessage(items.error) : undefined} retryItems={() => items.refetch()}/></Suspense>}

        {section === 'models' && <ModelsPanel request={request} userKey={session?.user?.id || 'local'}/>}

        {section === 'body' && <section className={styles.future}>
          <span className={styles.softLabel}>后续阶段接入</span><div className={styles.futureIcon}><UserRound size={42}/></div><h2>先确定一张属于你的身材底图</h2><p>这里将支持填写身高、体重、围度与比例，调整固定模特的体型，并保存确认后的底图。当前尚未采集身体数据，试衣间可以先上传自己的人物照片。</p><div className={styles.steps}>{['选择基础模特','填写和调整身材特征','确认并保存底图版本'].map((step,index) => <div key={step}><span>{index + 1}</span>{step}</div>)}</div><Link className={styles.secondary} href="/workspace/fitting">去试衣间上传人物照片<ArrowRight size={16}/></Link><p className={styles.small}>上身图用于外观参考，不作为真实尺码或松紧判断。</p>
        </section>}

        {section === 'settings' && <>
          <div className={styles.settingsIntro}><h2>为每项功能选择对应的服务</h2><p>识别、图片生成、360 视频独立配置。模特上传和转身视频导入可直接在本机使用，任务与结果会保存在当前账户。</p></div>
          <AISettings request={request} userKey={session?.user?.id || 'local'}/>
          <div className={styles.statusList}>{[
            ['衣物管理', '上传、分类、搜索、编辑、喜欢和删除', true],
            ['手动搭配', '选择自己的上衣和下装，保存组合', true],
            ['AI 衣物识别', '识别、逐件确认、可选单品图生成，使用识别服务', false],
            ['模特库与本地转身', '保存人物照片，导入视频提取 61 帧，拖动或播放查看', true],
            ['AI 穿搭推荐', capabilities.data?.ai.text ? '上游已启用，工作台入口待验证' : '尚未接入，当前使用手动组合', false],
            ['个人身材模特', '待接入模特素材、身体数据和图像编辑', false],
            ['真人试穿预览', '选模特或上传照片，生成试穿图，并可继续生成 360 转身', false],
          ].map(([label,description,ready]) => <div key={String(label)}><span className={ready ? styles.statusIconReady : styles.statusIcon}>{ready ? <CheckCircle2 size={20}/> : <Circle size={20}/>}</span><div><h3>{label}</h3><p>{description}</p></div><span className={ready ? styles.readyLabel : styles.softLabel}>{ready ? '本地可用' : label === 'AI 衣物识别' || label === '真人试穿预览' ? '需对应服务' : '待接入'}</span></div>)}</div>
          <div className={styles.system}><h3>本地运行状态</h3><div><span>数据服务</span><strong>{online ? '已连接' : '未连接'}</strong></div><div><span>数据库</span><strong>{health.data?.checks?.database === 'healthy' ? '正常' : '等待连接'}</strong></div><div><span>当前账户</span><strong>本地开发账户</strong></div><p>此工作区仅供本机验证，正式登录与公开部署将在后续阶段配置。</p><a href="https://github.com/Anyesh/wardrowbe" target="_blank" rel="noreferrer">基于 Wardrowbe 开源项目（MIT）</a></div>
        </>}
        </>}
      </div>
      <footer className={styles.footer}>爱衣橱 · 先用好已经拥有的衣服<span>本地功能验证阶段</span></footer>
    </main>
    <Dialog.Root open={editor !== null} onOpenChange={open => {if (!open) setEditor(null);}}><Dialog.Portal><Dialog.Overlay className={styles.overlay}/><Dialog.Content className={styles.dialog} onInteractOutside={event => event.preventDefault()}><Dialog.Title>{editor === 'new' ? '添加衣物' : '编辑衣物'}</Dialog.Title><Dialog.Description>保存一件真实衣物，开始建立自己的衣橱。</Dialog.Description><Dialog.Close className={styles.close} aria-label="关闭衣物表单"><X size={20}/></Dialog.Close>{editor && <ItemForm key={editor === 'new' ? 'new' : editor.id} item={editor === 'new' ? null : editor} request={request} onSaved={() => {setEditor(null); queryClient.invalidateQueries({queryKey: ['aiyi', 'items']}); setNotice('衣物已保存到你的衣橱。');}}/>}</Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={!!deleting} onOpenChange={open => {if (!open && !remove.isPending) setDeleting(null);}}><Dialog.Portal><Dialog.Overlay className={styles.overlay}/><Dialog.Content className={styles.dialog}><Dialog.Title>删除这件衣物？</Dialog.Title><Dialog.Description>“{deleting?.name || '未命名衣物'}”及其图片将被移除。此操作无法撤销。</Dialog.Description><div className={styles.dialogActions}><button className={styles.secondary} disabled={remove.isPending} onClick={() => setDeleting(null)}>保留衣物</button><button className={styles.danger} disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>{remove.isPending ? '删除中…' : '确认删除'}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}

function Empty({icon: Icon, title, text, action}: {icon: typeof Shirt; title: string; text: string; action?: React.ReactNode}) {
  return <section className={styles.empty}><div><Icon size={31}/></div><h2>{title}</h2><p>{text}</p>{action}</section>;
}
function ErrorPanel({message, retry}: {message: string; retry: () => void}) {
  return <div role="alert" className={styles.errorPanel}><p>{message}</p><button className={styles.secondary} onClick={retry}><RefreshCw size={15}/>重试</button></div>;
}
function ItemForm({item, request, onSaved}: {item: Item | null; request: <T>(path: string, init?: RequestInit) => Promise<T>; onSaved: () => void}) {
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
