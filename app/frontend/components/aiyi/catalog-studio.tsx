'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Sparkles } from 'lucide-react';
import { AIJob, AIRequest, WardrobeItem, ConfigurationNote, JobPagination, JobStatus, errorMessage, useAIJobs, useAIServices } from './ai-common';
import styles from './workbench.module.css';

export function CatalogStudio({request, userKey, items, selectedItemId = ''}: {request: AIRequest; userKey: string; items: WardrobeItem[]; selectedItemId?: string}) {
  const services = useAIServices(request, userKey);
  const jobs = useAIJobs(request, userKey, 'catalog');
  const queryClient = useQueryClient();
  const [itemId, setItemId] = useState(selectedItemId);
  useEffect(() => {if (selectedItemId) setItemId(selectedItemId);}, [selectedItemId]);
  const chosen = items.find(item => item.id === itemId);
  const generate = useMutation({mutationFn: () => {const data = new FormData(); data.set('item_id', itemId); return request<AIJob>('/ai/catalog-images', {method: 'POST', body: data});}, onSuccess: () => queryClient.invalidateQueries({queryKey: ['aiyi', 'ai-jobs', userKey, 'catalog']})});
  return <section className={`${styles.aiPanel} ${styles.catalogAnchor}`} id="catalog-studio" aria-labelledby="catalog-heading"><div className={styles.aiSectionHeading}><div><h2 id="catalog-heading"><Sparkles size={18}/>生成干净单品图</h2><p>从已有衣物生成干净背景的商品展示图，确认满意后再替换衣橱主图。</p></div></div><ConfigurationNote request={request} userKey={userKey} service="image"/>
    <div className={styles.catalogForm}>{chosen && <img src={chosen.image_url} alt="当前衣物原图"/>}<div><label className={styles.field}>选择衣物<select value={itemId} disabled={generate.isPending} onChange={event => setItemId(event.target.value)}><option value="">请选择一件已入库衣物</option>{items.map(item => <option key={item.id} value={item.id}>{item.name || item.type}</option>)}</select></label><button className={styles.primary} disabled={!chosen || !services.data?.image.configured || generate.isPending} onClick={() => generate.mutate()}><Sparkles size={15}/>{generate.isPending ? '正在提交…' : '生成这件衣物的单品图'}</button>{generate.isError && <p role="alert" className={styles.error}>{errorMessage(generate.error)}</p>}</div></div>
    {jobs.isError && <p role="alert" className={styles.error}>{errorMessage(jobs.error)} <button className={styles.textButton} onClick={() => jobs.refetch()}>重试</button></p>}
    <div className={styles.catalogResults}>{jobs.jobs.map(job => <CatalogResult key={job.id} job={job} request={request} userKey={userKey}/>)}</div>
    <JobPagination loaded={jobs.jobs.length} total={jobs.total} hasMore={jobs.hasNextPage} busy={jobs.isFetching} label="加载更多单品图记录" onMore={() => {void jobs.fetchNextPage({cancelRefetch: false});}}/>
  </section>;
}
function CatalogResult({job, request, userKey}: {job: AIJob; request: AIRequest; userKey: string}) {
  const queryClient = useQueryClient();
  const apply = useMutation({mutationFn: () => request<AIJob>(`/ai/catalog-images/${job.id}/apply`, {method: 'POST'}), onSuccess: () => {queryClient.invalidateQueries({queryKey: ['aiyi', 'ai-jobs', userKey, 'catalog']}); queryClient.invalidateQueries({queryKey: ['aiyi', 'items']});}});
  return <article className={styles.jobCard}><JobStatus job={job} request={request} userKey={userKey}/>{job.status === 'completed' && job.result?.image_url && <><div className={styles.tryOnComparison}><figure><img src={job.source_image_url} alt="生成单品图前的衣物原图"/><figcaption>原图</figcaption></figure><figure><img src={job.result.image_url} alt="生成的干净单品图"/><figcaption>生成的单品图</figcaption></figure></div>{job.result.applied ? <p className={styles.small}><Check size={14}/>已应用为衣橱主图</p> : <button className={styles.primary} disabled={apply.isPending} onClick={() => apply.mutate()}><Check size={15}/>{apply.isPending ? '正在应用…' : '确认使用这张单品图'}</button>}<p className={styles.small}>请核对颜色、图案与版型。确认后将替换衣橱中的这件衣物图片。</p></>}{apply.isError && <p role="alert" className={styles.error}>{errorMessage(apply.error)}</p>}</article>;
}
