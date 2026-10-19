'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw, Settings2 } from 'lucide-react';
import { AIRequest, AIServices, ServiceName, ServicePublic, errorMessage, json, serviceLabels, useAIServices } from './ai-common';
import styles from './workbench.module.css';

type CheckResult = {status: string; message?: string; model_listed?: boolean};
const descriptions: Record<ServiceName, string> = {
  recognition: '看懂图片中的衣物种类、颜色与细节，识别后由你确认入库。',
  image: '生成干净的单品图，或把衣橱中的衣服穿到人物照片上。',
  rotation: '把模特图或试穿图生成转身视频，再提取为可拖动的 360 帧序列。本地导入视频无需配置此服务。',
};
function providerDefaults(provider: ServicePublic['provider'], service: ServiceName) {
  if (provider === 'gemini') return {base_url: 'https://generativelanguage.googleapis.com/v1beta', model: service === 'recognition' ? 'gemini-3.5-flash' : 'gemini-3.1-flash-image'};
  if (provider === 'deepseek') return {base_url: 'https://api.deepseek.com', model: 'deepseek-flash'};
  if (provider === 'wavespeed') return {base_url: 'https://api.wavespeed.ai/api/v3', model: 'bytedance/seedance-2.0/image-to-video'};
  return {base_url: 'https://api.openai.com/v1', model: service === 'recognition' ? 'gpt-4.1-mini' : 'gpt-image-1.5'};
}

export function AISettings({request, userKey}: {request: AIRequest; userKey: string}) {
  const services = useAIServices(request, userKey);
  if (services.isPending) return <p role="status" className={styles.small}>正在读取三个服务的配置…</p>;
  if (services.isError || !services.data) return <div className={styles.errorPanel}><p>{errorMessage(services.error)}</p><button className={styles.secondary} onClick={() => services.refetch()}>重新读取</button></div>;
  return <><div className={styles.inlineNote}><Settings2 size={18}/><div><strong>三个服务分别配置、分别启用</strong><p>可以先配置图片服务验证试穿。识别、单品图与试穿、360 视频可以使用不同的平台和密钥。</p></div></div>{(['recognition', 'image', 'rotation'] as const).map(service => <ServiceCard key={`${userKey}-${service}`} service={service} config={services.data[service]} request={request} userKey={userKey}/>)}</>;
}

function ServiceCard({service, config, request, userKey}: {service: ServiceName; config: ServicePublic; request: AIRequest; userKey: string}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(config);
  const [key, setKey] = useState('');
  const [notice, setNotice] = useState('');
  const [checked, setChecked] = useState<(CheckResult & {model: string}) | null>(null);
  useEffect(() => {setForm(config); setChecked(null);}, [config]);
  const updateCache = (updated: ServicePublic) => queryClient.setQueryData<AIServices>(['aiyi', 'ai-services', userKey], previous => previous ? {...previous, [service]: updated} : previous);
  const save = useMutation({mutationFn: () => request<ServicePublic>(`/ai/services/${service}`, {...json({provider: form.provider, base_url: form.base_url.trim(), model: form.model.trim(), quality: form.quality, ...(key.trim() ? {api_key: key.trim()} : {})}), method: 'PUT'}), onSuccess: updated => {setKey(''); updateCache(updated); setNotice(`${serviceLabels[service]}配置已保存，可以检查连通性后实际验证。`);}});
  const clear = useMutation({mutationFn: () => request(`/ai/services/${service}/key`, {method: 'DELETE'}), onSuccess: () => {setKey(''); queryClient.invalidateQueries({queryKey: ['aiyi', 'ai-services', userKey]}); setNotice('已清除这个服务的已保存密钥。');}});
  const check = useMutation({mutationFn: () => request<CheckResult>(`/ai/services/${service}/check`, {method: 'POST'}), onSuccess: result => setChecked({...result, model: config.model})});
  const busy = save.isPending || clear.isPending || check.isPending;
  function submit(event: FormEvent) {event.preventDefault(); setNotice(''); setChecked(null); save.mutate();}
  return <section className={styles.aiPanel} aria-label={`${serviceLabels[service]}服务配置`}>
    <div className={styles.aiSectionHeading}><div><h2>{serviceLabels[service]}</h2><p>{descriptions[service]}</p></div><span className={config.configured ? styles.readyLabel : styles.softLabel}>{config.configured ? '已配置 · 需实际验证' : '尚未配置'}</span></div>
    <form onSubmit={submit}>
      <div className={styles.fieldRow}><label className={styles.field}>服务类型<select value={form.provider} disabled={busy} onChange={event => {
        const provider = event.target.value as ServicePublic['provider'];
        setForm({...form, provider, ...(provider === 'openai_compatible' ? {} : providerDefaults(provider, service))});
      }}>{service === 'rotation' ? <option value="wavespeed">WaveSpeed</option> : <><option value="openai">OpenAI 官方</option><option value="openai_compatible">兼容 OpenAI 的服务</option><option value="gemini">Gemini 原生接口</option>{service === 'recognition' && <option value="deepseek">DeepSeek 衣物识别</option>}</>}</select></label><label className={styles.field}>API 地址<input type="url" value={form.base_url} required disabled={busy} onChange={event => setForm({...form, base_url: event.target.value})}/></label></div>
      <div className={styles.fieldRow}><label className={styles.field}>模型名称<input required maxLength={200} value={form.model} disabled={busy} onChange={event => setForm({...form, model: event.target.value})}/></label><label className={styles.field}>{serviceLabels[service]} API 密钥<input type="password" autoComplete="new-password" spellCheck={false} value={key} disabled={busy} onChange={event => setKey(event.target.value)} placeholder={config.configured ? '留空保留现有密钥' : '填写这个服务的密钥'}/></label></div>
      {service === 'image' && <label className={styles.field}>图片质量<select value={form.quality} disabled={busy} onChange={event => setForm({...form, quality: event.target.value as ServicePublic['quality']})}><option value="low">低 · 先验证流程</option><option value="medium">中</option><option value="high">高</option></select></label>}
      <p className={styles.small}>密钥只由本地服务保存，不会回显或写入浏览器本地存储。{config.key_source === 'environment' ? '当前使用环境变量中的密钥。' : config.key_source === 'saved' ? '当前使用这个服务已保存的密钥。' : '这个服务还没有密钥。'}</p>
      <div className={styles.settingsActions}><button type="submit" className={styles.primary} disabled={busy || !form.base_url.trim() || !form.model.trim()}><Check size={15}/>{save.isPending ? '正在保存…' : '保存服务配置'}</button><button type="button" className={styles.secondary} disabled={busy || !config.configured} onClick={() => {setNotice(''); setChecked(null); check.mutate();}}><RefreshCw size={14}/>{check.isPending ? '正在检查…' : '检查已保存配置'}</button>{config.key_source === 'saved' && <button type="button" className={styles.textButton} disabled={busy} onClick={() => {setNotice(''); setChecked(null); clear.mutate();}}>清除此服务密钥</button>}</div>
    </form>
    {checked && <div role="status" aria-label={`${serviceLabels[service]}检查结果`} className={styles.inlineNote}><div><strong>{checked.message || '服务连通检查已完成。'}</strong><p>模型（{checked.model}）：{checked.model_listed === true ? '已在服务返回的模型列表中列出' : checked.model_listed === false ? '未在模型列表中列出，请核对模型名或访问权限' : '此服务未返回模型列表匹配结果'}。</p><p>连通或列出模型不代表实际生成已经通过，仍需提交真实图片验证。</p></div></div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}{[save, check, clear].map((operation, index) => operation.isError && <p key={index} role="alert" className={styles.error}>{errorMessage(operation.error)}</p>)}
  </section>;
}
