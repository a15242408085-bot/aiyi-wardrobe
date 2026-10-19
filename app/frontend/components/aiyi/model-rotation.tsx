'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw, RotateCw, Upload, UserRound, Video } from 'lucide-react';
import { AIRequest, AIJob, ConfigurationNote, FilePicker, JobPagination, JobStatus, errorMessage, useAIJobs, useAIServices } from './ai-common';
import { RotationViewer } from './rotation-viewer';
import styles from './workbench.module.css';

export function RotationAction({request, userKey, sourceJobId}: {request: AIRequest; userKey: string; sourceJobId: string}) {
  const services = useAIServices(request, userKey);
  const queryClient = useQueryClient();
  const [removeGreen, setRemoveGreen] = useState(false);
  const mutation = useMutation({mutationFn: () => {
    const data = new FormData(); data.set('source_job_id', sourceJobId); data.set('remove_green', String(removeGreen));
    return request<AIJob>('/ai/rotations', {method: 'POST', body: data});
  }, onSuccess: () => queryClient.invalidateQueries({queryKey: ['aiyi', 'ai-jobs', userKey, 'rotation']})});
  return <div className={styles.rotationAction}>
    <label className={styles.checkLine}><input type="checkbox" checked={removeGreen} disabled={mutation.isPending} onChange={event => setRemoveGreen(event.target.checked)}/>去除视频绿幕（仅适用于绿幕素材）</label>
    {removeGreen && <p className={styles.small}>绿色衣物也可能被去除，请检查生成结果。</p>}
    <button type="button" className={styles.secondary} disabled={!services.data?.rotation.configured || mutation.isPending} onClick={() => mutation.mutate()}><RotateCw size={15}/>{mutation.isPending ? '正在提交…' : '生成 360 转身'}</button>
    {!services.isPending && !services.data?.rotation.configured && <p className={styles.small}>先<Link className={styles.textButton} href="/workspace/settings">配置 360 视频服务</Link>，或在模特与 360 页面导入自己的转身视频。</p>}
    {mutation.isSuccess && <p role="status" className={styles.small}>已提交转身任务，可在下方转身记录中查看进度。</p>}
    {mutation.isError && <p role="alert" className={styles.error}>{errorMessage(mutation.error)}</p>}
  </div>;
}

export function RotationHistory({request, userKey}: {request: AIRequest; userKey: string}) {
  const jobs = useAIJobs(request, userKey, 'rotation');
  return <section className={styles.rotationHistory}>
    <div className={styles.aiSectionHeading}><div><h2>360 转身记录</h2><p>由真实视频提取的帧序列，可以旋转查看服装外观。</p></div><button className={styles.textButton} onClick={() => jobs.refetch()} disabled={jobs.isFetching}><RefreshCw size={14}/>刷新记录</button></div>
    {jobs.isPending && <p role="status" className={styles.small}>正在读取转身记录…</p>}
    {jobs.isError && <p role="alert" className={styles.error}>{errorMessage(jobs.error)}</p>}
    {!jobs.isPending && !jobs.jobs.length && <p className={styles.small}>还没有转身记录。可以从模特或试穿结果生成，也可以导入自己的视频。</p>}
    <div className={styles.rotationGrid}>{jobs.jobs.map(job => <article key={job.id} className={styles.jobCard}><h3>{job.result?.name || '360 转身展示'}</h3><JobStatus job={job} request={request} userKey={userKey}/>{job.status === 'completed' && <><RotationViewer frames={job.result?.frame_urls || []} name={job.result?.name || '转身展示'}/>{job.result?.video_url && <a href={job.result.video_url} className={styles.textButton} target="_blank" rel="noreferrer">查看原始视频</a>}</>}</article>)}</div>
    <JobPagination loaded={jobs.jobs.length} total={jobs.total} hasMore={jobs.hasNextPage} busy={jobs.isFetching} label="加载更多转身记录" onMore={() => {void jobs.fetchNextPage({cancelRefetch: false});}}/>
  </section>;
}

function VideoImport({request, userKey}: {request: AIRequest; userKey: string}) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [removeGreen, setRemoveGreen] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const [inputKey, setInputKey] = useState(0);
  useEffect(() => {if (!file) {setPreview(''); return;} const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url);}, [file]);
  const upload = useMutation({mutationFn: () => {const data = new FormData(); data.set('video', file!); data.set('name', name.trim()); data.set('remove_green', String(removeGreen)); return request<AIJob>('/ai/rotations/import', {method: 'POST', body: data});}, onSuccess: () => {setFile(null); setName(''); setInputKey(value => value + 1); queryClient.invalidateQueries({queryKey: ['aiyi', 'ai-jobs', userKey, 'rotation']});}, onError: error => setError(errorMessage(error))});
  return <section className={styles.aiPanel} aria-labelledby="video-import-heading"><div className={styles.aiSectionHeading}><div><h2 id="video-import-heading"><Video size={18}/>导入转身视频</h2><p>无需云端密钥。在本机提取 61 帧，保存为可拖动查看的转身展示。</p></div><span className={styles.readyLabel}>本地处理</span></div>
    <form onSubmit={event => {event.preventDefault(); setError(''); upload.mutate();}}><label className={styles.field}>选择转身视频<input key={inputKey} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" disabled={upload.isPending} onChange={event => {const next = event.target.files?.[0]; if (!next) return; if (!/\.(mp4|mov)$/i.test(next.name) || next.size > 100 * 1024 * 1024) {setError('请选择不超过 100 MB 的 MP4 或 MOV 视频。'); event.target.value = ''; return;} setFile(next); setError(''); if (!name) setName(next.name.replace(/\.[^.]+$/, '').slice(0, 100));}}/></label>
      {preview && <video className={styles.importVideo} src={preview} controls preload="metadata"/>}
      <label className={styles.field}>转身展示名称<input value={name} maxLength={100} required disabled={upload.isPending} onChange={event => setName(event.target.value)} placeholder="例如：白衬衫日常穿搭"/></label>
      <label className={styles.checkLine}><input type="checkbox" checked={removeGreen} disabled={upload.isPending} onChange={event => setRemoveGreen(event.target.checked)}/>视频使用绿幕背景，需要去除绿色</label>
      <p className={styles.small}>支持 MP4、MOV，100 MB 以内、30 秒以内，最长边不超过 4096 像素。建议人物完整转一圈，镜头保持固定。{removeGreen && '去绿幕可能同时影响绿色衣物，请检查结果。'}</p>
      <button className={styles.primary} disabled={!file || !name.trim() || upload.isPending} type="submit"><Upload size={15}/>{upload.isPending ? '正在上传视频…' : '导入并生成转身展示'}</button>
    </form>{error && <p role="alert" className={styles.error}>{error}</p>}{upload.isSuccess && <p role="status" className={styles.small}>视频已提交本地处理，进度显示在转身记录中。</p>}
  </section>;
}

export function ModelsPanel({request, userKey}: {request: AIRequest; userKey: string}) {
  const queryClient = useQueryClient();
  const jobs = useAIJobs(request, userKey, 'model');
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [inputKey, setInputKey] = useState(0);
  const upload = useMutation({mutationFn: () => {const data = new FormData(); data.set('image', file!); data.set('name', name.trim()); return request<AIJob>('/ai/models', {method: 'POST', body: data});}, onSuccess: () => {setFile(null); setName(''); setInputKey(value => value + 1); queryClient.invalidateQueries({queryKey: ['aiyi', 'ai-jobs', userKey, 'model']});}, onError: error => setError(errorMessage(error))});
  function submit(event: FormEvent) {event.preventDefault(); setError(''); upload.mutate();}
  return <>
    <section className={styles.aiPanel}><div className={styles.aiSectionHeading}><div><h2><UserRound size={18}/>我的模特库</h2><p>保存真实人物照片，用于反复试穿。上传与保存无需 AI 服务。</p></div></div><form className={styles.modelUpload} onSubmit={submit}><FilePicker key={inputKey} label="选择模特人物照片" file={file} onFile={setFile} disabled={upload.isPending} onError={setError}/><div><label className={styles.field}>模特名称<input maxLength={100} required value={name} disabled={upload.isPending} onChange={event => setName(event.target.value)} placeholder="例如：我的正面全身照"/></label><p className={styles.small}>建议使用全身入镜、正面站姿、背景干净的照片，便于保持试穿前后的人物一致。</p><button type="submit" className={styles.primary} disabled={!file || !name.trim() || upload.isPending}><Check size={15}/>{upload.isPending ? '正在保存…' : '保存模特'}</button></div></form>{error && <p role="alert" className={styles.error}>{error}</p>}
      {jobs.isPending && <p className={styles.small}>正在读取模特库…</p>}{jobs.isError && <p role="alert" className={styles.error}>{errorMessage(jobs.error)} <button className={styles.textButton} onClick={() => jobs.refetch()}>重试</button></p>}{!jobs.isPending && !jobs.jobs.length && <p className={styles.small}>模特库还是空的。上传一张你自己的照片开始。</p>}
      <div className={styles.modelGrid}>{jobs.jobs.map(job => <article key={job.id} className={styles.jobCard}>{job.status === 'completed' && job.result?.image_url ? <><img className={styles.modelImage} src={job.result.image_url} alt={job.result.name || '已保存模特'}/><h3>{job.result.name || '我的模特'}</h3><Link className={styles.primary} href={`/workspace/fitting?model=${encodeURIComponent(job.id)}`}>用这个模特试穿</Link><RotationAction request={request} userKey={userKey} sourceJobId={job.id}/></> : <JobStatus job={job} request={request} userKey={userKey}/>}</article>)}</div><JobPagination loaded={jobs.jobs.length} total={jobs.total} hasMore={jobs.hasNextPage} busy={jobs.isFetching} label="加载更多模特" onMore={() => {void jobs.fetchNextPage({cancelRefetch: false});}}/>
    </section>
    <VideoImport request={request} userKey={userKey}/>
    <RotationHistory request={request} userKey={userKey}/>
  </>;
}
