'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2, Upload, RefreshCw } from 'lucide-react';
import styles from './workbench.module.css';

export type AIRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
export type WardrobeItem = { id: string; name: string | null; type: string; image_url: string; thumbnail_url?: string };
export type ServiceName = 'recognition' | 'image' | 'rotation';
export type ServicePublic = {configured: boolean; provider: 'openai' | 'openai_compatible' | 'gemini' | 'deepseek' | 'wavespeed'; base_url: string; model: string; quality: 'low' | 'medium' | 'high'; key_source: 'saved' | 'environment' | 'none'};
export type AIServices = Record<ServiceName, ServicePublic>;
export const serviceLabels: Record<ServiceName, string> = {recognition: '衣物识别', image: '单品图与试穿', rotation: '360 视频'};
export type Candidate = {
  candidate_id: string; name: string; type: string; colors: string[]; primary_color: string | null;
  season: string[]; material: string | null; notes: string | null; image_url: string;
  image_kind?: 'generated' | 'crop' | 'source'; crop_warning?: string; source_image_url?: string; generation_error?: string | null;
};
export type AIJob = {
  id: string; kind: 'recognition' | 'try_on' | 'catalog' | 'model' | 'rotation'; status: 'queued' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'interrupted';
  stage: string; progress: number; source_image_url: string; error?: string | {message?: string} | null;
  result?: {candidates?: Candidate[]; item_ids?: string[]; image_url?: string; item_id?: string; applied?: boolean; name?: string; frame_urls?: string[]; video_url?: string; frame_count?: number; source_job_id?: string; model_id?: string} | null;
  created_at: string; updated_at: string;
};
const activeJob = (job: AIJob) => job.status === 'queued' || job.status === 'running';
export const json = (body: unknown): RequestInit => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '请求没有完成，请重试。';
const jobError = (job: AIJob) => typeof job.error === 'string' ? job.error : job.error?.message;
const statusLabels: Record<AIJob['status'], string> = {queued: '排队中', running: '处理中', awaiting_confirmation: '等待你确认', completed: '已完成', failed: '处理失败', interrupted: '任务已中断'};

export function useAIServices(request: AIRequest, userKey: string) {
  return useQuery({queryKey: ['aiyi', 'ai-services', userKey], queryFn: () => request<AIServices>('/ai/services'), retry: false});
}
type AIJobPage = {jobs: AIJob[]; total: number; has_more: boolean; next_offset: number | null};
export function useAIJobs(request: AIRequest, userKey: string, kind: AIJob['kind']) {
  const query = useInfiniteQuery({
    queryKey: ['aiyi', 'ai-jobs', userKey, kind, 'pages'],
    queryFn: ({pageParam}) => request<AIJobPage>(`/ai/jobs?kind=${kind}&offset=${pageParam}&limit=30`),
    initialPageParam: 0,
    getNextPageParam: lastPage => lastPage.has_more && lastPage.next_offset != null ? lastPage.next_offset : undefined,
    retry: false,
    refetchInterval: query => query.state.data?.pages.some(page => page.jobs.some(activeJob)) ? 2500 : false,
  });
  // New tasks may shift offset pages between requests. Keep one card per server task.
  const jobs = Array.from(new Map((query.data?.pages || []).flatMap(page => page.jobs).map(job => [job.id, job])).values());
  return {...query, jobs, total: query.data?.pages[0]?.total ?? jobs.length};
}
export function JobPagination({loaded, total, hasMore, busy, label, onMore}: {loaded: number; total: number; hasMore: boolean; busy: boolean; label: string; onMore: () => void}) {
  if (!loaded) return null;
  return <div className={styles.settingsActions}><span className={styles.small}>已显示 {loaded} / {total} 条任务</span>{hasMore && <button className={styles.secondary} disabled={busy} onClick={onMore}>{busy ? '正在读取…' : label}</button>}</div>;
}
export function FilePicker({label, file, onFile, disabled, onError}: {label: string; file: File | null; onFile: (file: File) => void; disabled: boolean; onError: (message: string) => void}) {
  const [preview, setPreview] = useState('');
  useEffect(() => {
    if (!file) {setPreview(''); return;}
    const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url);
  }, [file]);
  return <label className={`${styles.upload} ${styles.aiUpload}`}>
    {preview ? <img src={preview} alt={`${label}预览`}/> : <><Upload size={23}/><strong>{label}</strong><span>JPG、PNG 或 WebP，最大 20 MB</span></>}
    <input type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled} aria-label={label} onChange={event => {
      const next = event.target.files?.[0]; if (!next) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(next.type) || next.size > 20 * 1024 * 1024) {onError('请选择不超过 20 MB 的 JPG、PNG 或 WebP 图片。'); event.target.value = ''; return;}
      onFile(next); onError('');
    }}/>{preview && <span>{file?.name} · 点击更换</span>}
  </label>;
}
export function ConfigurationNote({request, userKey, service}: {request: AIRequest; userKey: string; service: ServiceName}) {
  const settings = useAIServices(request, userKey);
  if (settings.isPending) return <p className={styles.small}>正在读取服务配置…</p>;
  if (settings.isError) return <p role="alert" className={styles.error}>无法读取服务配置。<button className={styles.textButton} onClick={() => settings.refetch()}>重新读取</button></p>;
  if (settings.data?.[service].configured) return <p className={styles.small}>将使用你配置的{serviceLabels[service]}服务处理图片。配置完成不代表效果已经验证。</p>;
  return <div className={styles.inlineNote}><Settings2 size={17}/><div><strong>{serviceLabels[service]}服务尚未配置</strong><p>为这项功能单独配置服务和密钥。<Link href="/workspace/settings">前往功能与设置 →</Link></p></div></div>;
}
export function JobStatus({job, request, userKey}: {job: AIJob; request: AIRequest; userKey: string}) {
  const queryClient = useQueryClient();
  const retry = useMutation({mutationFn: () => request<AIJob>(`/ai/jobs/${job.id}/retry`, {method: 'POST'}), onSuccess: () => queryClient.invalidateQueries({queryKey: ['aiyi', 'ai-jobs', userKey]})});
  return <>
    <div className={styles.jobHeading}><strong>{statusLabels[job.status]}</strong><span>{new Date(job.created_at).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</span></div>
    {activeJob(job) && <div className={styles.jobProgress} role="status"><p>{job.stage || '正在处理，请稍候'}{Number.isFinite(job.progress) ? ` · ${Math.round(job.progress)}%` : ''}</p><progress aria-label="任务进度" max={100} value={job.progress || 0}/><span>可以离开页面，重新打开后会继续显示任务状态。</span></div>}
    {(job.status === 'failed' || job.status === 'interrupted') && <div role="alert" className={styles.jobFailure}><p>{jobError(job) || '本次任务未完成，尚未保存结果。'}</p><p className={styles.small}>部分云端图片任务重试可能再次计费；转身任务会优先续查已提交的任务。</p><button className={styles.secondary} disabled={retry.isPending} onClick={() => retry.mutate()}><RefreshCw size={14}/>{retry.isPending ? '正在提交…' : '重新发起任务'}</button>{retry.isError && <p className={styles.error}>{errorMessage(retry.error)}</p>}</div>}
  </>;
}

