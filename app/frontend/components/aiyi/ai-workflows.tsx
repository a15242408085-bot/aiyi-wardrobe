'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, RefreshCw, ScanLine, Shirt, Sparkles } from 'lucide-react';
import { garmentColors, recognitionGarmentTypes, garmentTypeLabel, tryOnCategory, tryOnCategoryLabels } from './wardrobe-options';
import styles from './workbench.module.css';
import { AIRequest, AIJob, Candidate, WardrobeItem, useAIServices, useAIJobs, FilePicker, JobPagination, JobStatus, ConfigurationNote, errorMessage, json } from './ai-common';
import { RotationAction, RotationHistory } from './model-rotation';
export type { AIRequest } from './ai-common';

export function RecognitionPanel({request, userKey}: {request: AIRequest; userKey: string}) {
  const queryClient = useQueryClient();
  const settings = useAIServices(request, userKey);
  const jobs = useAIJobs(request, userKey, 'recognition');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [uploadKey, setUploadKey] = useState(0);
  const [generateProductImages, setGenerateProductImages] = useState(false);
  const submit = useMutation({mutationFn: () => {
    const data = new FormData(); data.set('image', file!); data.set('generate_product_images', String(generateProductImages)); return request<AIJob>('/ai/recognitions', {method: 'POST', body: data});
  }, onSuccess: () => {setFile(null); setUploadKey(value => value + 1); queryClient.invalidateQueries({queryKey: ['aiyi', 'ai-jobs', userKey]});}, onError: error => setError(errorMessage(error))});
  const orderedJobs = [...jobs.jobs].sort((a, b) => Number(b.status !== 'completed') - Number(a.status !== 'completed'));
  return <section className={styles.aiPanel} aria-labelledby="recognition-heading">
    <div className={styles.aiSectionHeading}><div><h2 id="recognition-heading"><Sparkles size={18}/>AI 识别入库</h2><p>上传清晰的单件衣物照片，识别后检查名称、类别和颜色，再确认保存。</p></div><span className={styles.softLabel}>先识别 · 再确认</span></div>
    <ConfigurationNote request={request} userKey={userKey} service="recognition"/>
    <div className={styles.recognitionUpload}><FilePicker key={uploadKey} label="选择待识别的衣物照片" file={file} onFile={setFile} disabled={submit.isPending} onError={setError}/><div><p className={styles.small}>也可以上传整身穿搭图。识别出的多件衣物会分别展示，图片保留原图或裁剪区域。</p><label className={styles.checkLine}><input type="checkbox" checked={generateProductImages} disabled={!settings.data?.image.configured || submit.isPending} onChange={event => setGenerateProductImages(event.target.checked)}/>同时生成干净单品图</label><p className={styles.small}>{generateProductImages ? '上衣、外套、下装、鞋、包，每类最多保留一件，分别调用图片服务生成，可能产生多次费用。' : '关闭时只识别并保留原图或裁剪图。'}{!settings.data?.image.configured && <Link href="/workspace/settings"> 生成单品图需配置图片服务。</Link>}</p><button className={styles.primary} disabled={!file || !settings.data?.recognition.configured || (generateProductImages && !settings.data?.image.configured) || submit.isPending} onClick={() => {setError(''); submit.mutate();}}><Sparkles size={16}/>{submit.isPending ? '正在上传…' : '开始识别'}</button>{error && <p role="alert" className={styles.error}>{error}</p>}</div></div>
    {jobs.isError && <p role="alert" className={styles.error}>任务读取失败：{errorMessage(jobs.error)} <button className={styles.textButton} onClick={() => jobs.refetch()}>重试</button></p>}
    {!!orderedJobs.length && <details className={styles.jobHistory} open={orderedJobs.some(job => job.status !== 'completed')}><summary>识别任务与待确认衣物（{jobs.total}）</summary><div className={styles.jobs}>{orderedJobs.map(job => <article key={job.id} className={styles.jobCard}>
      <JobStatus job={job} request={request} userKey={userKey}/>
      {job.status === 'awaiting_confirmation' && <CandidateReview job={job} request={request} userKey={userKey}/>}
      {job.status === 'completed' && <p className={styles.small}><Check size={14}/> 已确认入库 {job.result?.item_ids?.length || 0} 件衣物。</p>}
    </article>)}</div></details>}
    <JobPagination loaded={orderedJobs.length} total={jobs.total} hasMore={jobs.hasNextPage} busy={jobs.isFetching} label="加载更多识别任务" onMore={() => {void jobs.fetchNextPage({cancelRefetch: false});}}/>
  </section>;
}
function CandidateReview({job, request, userKey}: {job: AIJob; request: AIRequest; userKey: string}) {
  const queryClient = useQueryClient();
  const [candidates, setCandidates] = useState(() => (job.result?.candidates || []).map(candidate => ({...candidate, type: candidate.type === 'unknown' ? 'accessories' : candidate.type, selected: true})));
  const selected = candidates.filter(candidate => candidate.selected);
  const confirm = useMutation({mutationFn: () => request<AIJob>(`/ai/recognitions/${job.id}/confirm`, json({candidates: selected.map(({candidate_id, name, type, colors, primary_color, season, material, notes}) => ({candidate_id, name: name.trim(), type, colors, primary_color, season, material, notes}))})),
    onSuccess: () => {queryClient.invalidateQueries({queryKey: ['aiyi', 'ai-jobs', userKey]}); queryClient.invalidateQueries({queryKey: ['aiyi', 'items']});}});
  function change(id: string, patch: Partial<Candidate & {selected: boolean}>) {setCandidates(value => value.map(candidate => candidate.candidate_id === id ? {...candidate, ...patch} : candidate));}
  return <div className={styles.candidateReview}>
    <p className={styles.small}>勾选要入库的衣物。识别可能有偏差，保存前可以直接修改。<a href={job.source_image_url} target="_blank" rel="noreferrer" className={styles.textButton}>回看上传原图</a></p>
    {candidates.map(candidate => <div key={candidate.candidate_id} className={`${styles.candidate} ${!candidate.selected ? styles.candidateMuted : ''}`}>
      <label className={styles.candidateCheck}><input type="checkbox" checked={candidate.selected} disabled={confirm.isPending} onChange={event => change(candidate.candidate_id, {selected: event.target.checked})}/><span>保存这件</span></label>
      <img src={candidate.image_url || job.source_image_url} alt={candidate.name || '识别出的衣物'}/>
      <div className={styles.candidateFields}><label className={styles.field}>衣物名称<input aria-label={`衣物名称 ${candidate.candidate_id}`} maxLength={100} value={candidate.name} disabled={!candidate.selected || confirm.isPending} onChange={event => change(candidate.candidate_id, {name: event.target.value})}/></label><div className={styles.fieldRow}>
        <label className={styles.field}>类别<select value={candidate.type} disabled={!candidate.selected || confirm.isPending} onChange={event => change(candidate.candidate_id, {type: event.target.value})}>{!recognitionGarmentTypes.some(([value]) => value === candidate.type) && <option value={candidate.type}>{candidate.type}</option>}{recognitionGarmentTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className={styles.field}>主色<select value={candidate.primary_color || ''} disabled={!candidate.selected || confirm.isPending} onChange={event => change(candidate.candidate_id, {primary_color: event.target.value || null, colors: event.target.value ? [event.target.value] : []})}><option value="">未确定</option>{candidate.primary_color && !garmentColors.some(([value]) => value === candidate.primary_color) && <option value={candidate.primary_color}>{candidate.primary_color}</option>}{garmentColors.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div><label className={styles.field}>备注<input maxLength={1000} value={candidate.notes || ''} disabled={!candidate.selected || confirm.isPending} onChange={event => change(candidate.candidate_id, {notes: event.target.value})}/></label>{candidate.image_kind === 'generated' && <span className={styles.softLabel}>已生成干净单品图</span>}{candidate.source_image_url && <a href={candidate.source_image_url} className={styles.textButton} target="_blank" rel="noreferrer">回看衣物原图</a>}{candidate.crop_warning && <p className={styles.small}>{candidate.crop_warning}</p>}{candidate.generation_error && <p className={styles.error}>单品图生成未完成，已保留原图：{candidate.generation_error}</p>}</div>
    </div>)}
    {confirm.isError && <p role="alert" className={styles.error}>{errorMessage(confirm.error)}</p>}
    <button className={styles.primary} disabled={!selected.length || selected.some(candidate => !candidate.name.trim()) || confirm.isPending} onClick={() => confirm.mutate()}><Check size={16}/>{confirm.isPending ? '正在保存…' : `确认入库 ${selected.length} 件`}</button>
  </div>;
}

export function FittingPanel({request, userKey, items, itemsLoading, itemsError, retryItems}: {request: AIRequest; userKey: string; items: WardrobeItem[]; itemsLoading: boolean; itemsError?: string; retryItems: () => void}) {
  const queryClient = useQueryClient();
  const settings = useAIServices(request, userKey);
  const jobs = useAIJobs(request, userKey, 'try_on');
  const models = useAIJobs(request, userKey, 'model');
  const searchParams = useSearchParams();
  const requestedModel = searchParams.get('model') || '';
  const [sourceMode, setSourceMode] = useState<'upload' | 'model'>(requestedModel ? 'model' : 'upload');
  const [modelId, setModelId] = useState(requestedModel);
  const linkedModel = useQuery({queryKey: ['aiyi', 'selected-model', userKey, requestedModel], queryFn: () => request<AIJob>(`/ai/jobs/${encodeURIComponent(requestedModel)}`), enabled: !!requestedModel, retry: false});
  useEffect(() => {if (requestedModel) {setModelId(requestedModel); setSourceMode('model');}}, [requestedModel]);
  const availableModels = Array.from(new Map([...models.jobs, ...(linkedModel.data ? [linkedModel.data] : [])].filter(job => job.kind === 'model' && job.status === 'completed' && job.result?.image_url).map(job => [job.id, job])).values());
  const chosenModel = availableModels.find(job => job.id === modelId);
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const supported = items.filter(item => tryOnCategory(item.type));
  useEffect(() => {if (!itemsLoading && !itemsError) setSelected(previous => previous.filter(id => items.some(item => item.id === id)));}, [items, itemsLoading, itemsError]);
  const submit = useMutation({mutationFn: () => {
    const data = new FormData(); if (sourceMode === 'model') data.set('model_id', modelId); else data.set('person_image', file!); data.set('item_ids', JSON.stringify(selected)); if (prompt.trim()) data.set('prompt', prompt.trim());
    return request<AIJob>('/ai/try-ons', {method: 'POST', body: data});
  }, onSuccess: () => queryClient.invalidateQueries({queryKey: ['aiyi', 'ai-jobs', userKey]}), onError: error => setError(errorMessage(error))});
  function toggle(item: WardrobeItem) {
    setError('');
    setSelected(previous => previous.includes(item.id) ? previous.filter(id => id !== item.id) : [...previous.filter(id => tryOnCategory(items.find(candidate => candidate.id === id)?.type || '') !== tryOnCategory(item.type)), item.id]);
  }
  return <>
    <ConfigurationNote request={request} userKey={userKey} service="image"/>
    <section className={styles.fittingBuilder}>
      <div className={styles.personInput}><h2>1. 选择人物照片</h2><div className={styles.sourceTabs}><button type="button" aria-pressed={sourceMode === 'upload'} disabled={submit.isPending} onClick={() => setSourceMode('upload')}>上传照片</button><button type="button" aria-pressed={sourceMode === 'model'} disabled={submit.isPending} onClick={() => setSourceMode('model')}>从模特库选择</button></div>{sourceMode === 'upload' ? <FilePicker label="上传人物全身照" file={file} onFile={setFile} disabled={submit.isPending} onError={setError}/> : <div><label className={styles.field}>选择已保存模特<select value={modelId} disabled={submit.isPending} onChange={event => setModelId(event.target.value)}><option value="">请选择模特</option>{availableModels.map(model => <option value={model.id} key={model.id}>{model.result?.name || '我的模特'}</option>)}</select></label>{chosenModel && <img className={styles.selectedModelImage} src={chosenModel.result?.image_url} alt={chosenModel.result?.name || '选中的模特'}/>}<Link className={styles.textButton} href="/workspace/models">去模特库保存人物照片</Link>{(models.isError || linkedModel.isError) && <p className={styles.error}>模特读取失败，请重新选择或刷新页面。</p>}<JobPagination loaded={models.jobs.length} total={models.total} hasMore={models.hasNextPage} busy={models.isFetching} label="加载更多模特" onMore={() => {void models.fetchNextPage({cancelRefetch: false});}}/></div>}<p className={styles.small}>建议使用单人、正面、身体无遮挡的清晰照片。生成时将尽量保持人物的脸、体型和姿势。</p><label className={styles.field}>补充要求（选填）<textarea rows={3} maxLength={1000} value={prompt} disabled={submit.isPending} onChange={event => setPrompt(event.target.value)} placeholder="例如：把选中的白色上衣和牛仔裤穿到人物身上"/></label></div>
      <div className={styles.garmentPicker}><h2>2. 选择衣橱里的衣物 <span>{selected.length} / 5</span></h2><p className={styles.small}>上衣、外套、下装、鞋、包，每类选一件，最多 5 件。同类重新选择会替换原来的选择。</p>
        {itemsLoading ? <p role="status" className={styles.small}>正在读取衣物…</p> : itemsError ? <p className={styles.error} role="alert">{itemsError}<button className={styles.textButton} onClick={retryItems}>重试</button></p> : !supported.length ? <div className={styles.fittingEmpty}><Shirt size={28}/><p>先把上衣、外套、下装、鞋或包保存到衣橱。</p><Link href="/workspace/wardrobe" className={styles.secondary}>去添加衣物</Link></div> : <div className={styles.fittingItems}>{supported.map(item => <button type="button" key={item.id} disabled={submit.isPending} aria-pressed={selected.includes(item.id)} onClick={() => toggle(item)} className={selected.includes(item.id) ? styles.garmentSelected : ''}><img src={item.thumbnail_url || item.image_url} alt=""/><strong>{item.name || garmentTypeLabel(item.type)}</strong><span>{tryOnCategoryLabels[tryOnCategory(item.type)!]}{selected.includes(item.id) && ' · 已选'}</span></button>)}</div>}
        {items.some(item => !tryOnCategory(item.type)) && <p className={styles.small}>连衣裙和未分类衣物暂不参与本轮试穿。</p>}
      </div>
      <div className={styles.fittingSubmit}><div><strong>3. 生成试穿图</strong><p className={styles.small}>图片会发送到你配置的 AI 服务。结果自动保存，可用作外观参考。</p></div><button className={styles.primary} disabled={(sourceMode === 'upload' ? !file : !chosenModel) || !selected.length || !settings.data?.image.configured || submit.isPending || itemsLoading || !!itemsError} onClick={() => {setError(''); submit.mutate();}}><ScanLine size={16}/>{submit.isPending ? '正在提交…' : `生成试穿图${selected.length ? ` · ${selected.length} 件衣物` : ''}`}</button>{error && <p className={styles.error} role="alert">{error}</p>}</div>
    </section>
    <div className={styles.aiSectionHeading}><h2>试穿记录</h2><button className={styles.textButton} onClick={() => jobs.refetch()} disabled={jobs.isFetching}><RefreshCw size={14}/>刷新状态</button></div>
    {jobs.isPending ? <p className={styles.small}>正在读取试穿记录…</p> : jobs.isError && !jobs.jobs.length ? <p role="alert" className={styles.error}>{errorMessage(jobs.error)}</p> : !jobs.jobs.length ? <p className={styles.small}>生成任务提交后会显示在这里，刷新页面也能继续查看。</p> : <div className={styles.tryOnResults}>{jobs.jobs.map(job => <article key={job.id} className={styles.jobCard}><JobStatus job={job} request={request} userKey={userKey}/>{job.status === 'completed' && job.result?.image_url && <><div className={styles.tryOnComparison}><figure><img src={job.source_image_url} alt="试穿前的人物照片"/><figcaption>人物原图</figcaption></figure><figure><a href={job.result.image_url} target="_blank" rel="noreferrer"><img src={job.result.image_url} alt="AI 生成的试穿结果"/></a><figcaption>AI 试穿结果</figcaption></figure></div><a className={styles.secondary} href={job.result.image_url} download={`爱衣橱-试穿-${job.id}.jpg`}><Download size={14}/>下载试穿图</a><p className={styles.small}>已保存在当前账户。请检查衣物细节与人物一致性。</p><RotationAction request={request} userKey={userKey} sourceJobId={job.id}/></>}</article>)}</div>}
    {jobs.isError && !!jobs.jobs.length && <p role="alert" className={styles.error}>读取更多任务失败：{errorMessage(jobs.error)}</p>}
    <JobPagination loaded={jobs.jobs.length} total={jobs.total} hasMore={jobs.hasNextPage} busy={jobs.isFetching} label="加载更多试穿记录" onMore={() => {void jobs.fetchNextPage({cancelRefetch: false});}}/>
    <RotationHistory request={request} userKey={userKey}/>
  </>;
}

export { AISettings } from './service-settings';
