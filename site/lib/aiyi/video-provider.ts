/** Official Ark video tasks. A paid POST is never retried automatically. */
// @ts-ignore TS5097: Native Node tests load this source directly; the Worker bundler also resolves it.
import { ProviderError, validateRecognitionInput } from './providers.ts';

export type RotationEnv = { AIYI_VIDEO_KEY?: string; AIYI_VIDEO_MODEL?: string };
export type RotationInput = { image: string };
export type RotationStatus = { status: 'queued' | 'running' | 'succeeded' | 'failed' | 'expired'; videoUrl?: string; message?: string };
const BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seedance-1-0-pro-250528';
const MAX_JSON = 128 * 1024;
const MAX_VIDEO = 32 * 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9_-]{1,160}$/;
const UNKNOWN = '视频请求已发送，但尚未确认提交结果。请先核对本次任务，不要重复生成，以免重复付费。';
const PROMPT = 'One continuous full-body wardrobe turntable shot. The person in the reference turns slowly one complete 360-degree revolution, returning to the starting orientation. Keep the camera fully fixed, the person centered, and the entire body and shoes visible. Preserve exactly the same face, identity, hairstyle, body proportions, garment shapes, colors, prints, materials, lighting and background throughout. Keep arms relaxed in the same position. No walking, gestures, camera orbit, zoom, cuts, text, extra people or audio.';

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalidResponse(): never { throw new ProviderError('invalid_response', '视频服务返回的数据无法读取，请稍后查询同一任务。'); }
function key(env: RotationEnv): string {
  const value = env.AIYI_VIDEO_KEY;
  if (typeof value !== 'string' || !value.length || value.length > 1024 || /[^\x21-\x7e]/.test(value)) {
    throw new ProviderError('not_configured', '转身视频服务尚未配置，请联系网站管理员。');
  }
  return value;
}
export function rotationModel(env: RotationEnv): string {
  const value = env.AIYI_VIDEO_MODEL ?? DEFAULT_MODEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value)) throw new ProviderError('configuration_error', '转身视频模型设置不正确，请联系网站管理员。');
  return value;
}
export function validateRotationInput(body: unknown): RotationInput { return validateRecognitionInput(body); }
function taskId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID.test(value)) throw new ProviderError('invalid_request', '视频任务编号无效，请查看原有任务记录。');
  return value;
}
function mediaUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) invalidResponse();
  let parsed: URL;
  try { parsed = new URL(value); } catch { invalidResponse(); }
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash
      || authority?.toLowerCase() !== parsed.hostname.toLowerCase()
      || !(parsed.hostname.endsWith('.volces.com') || parsed.hostname.endsWith('.volccdn.com'))) invalidResponse();
  return value;
}
function httpError(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('provider_access', '视频服务权限验证未通过，请联系网站管理员。');
  if (status === 402 || status === 429) return new ProviderError('provider_limit', '视频服务额度不足或当前繁忙，请稍后再试。');
  if (status === 400 || status === 404 || status === 422) return new ProviderError('unsupported_request', '视频服务未接受此请求，请联系网站管理员检查模型和参数。');
  return new ProviderError('provider_error', '视频服务暂时不可用，请稍后查询同一任务。');
}
async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON) { await response.body?.cancel(); invalidResponse(); }
  if (!response.body) invalidResponse();
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON) { await reader.cancel(); invalidResponse(); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch { invalidResponse(); }
  finally { reader.releaseLock(); }
}
async function request(path: string, env: RotationEnv, payload: unknown | undefined, signal?: AbortSignal): Promise<unknown> {
  const credential = key(env), paid = payload !== undefined;
  if (signal?.aborted) throw new ProviderError('cancelled', '请求已取消。');
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false, definitelyRejected = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, paid ? 60000 : 30000);
  try {
    const response = await fetch(`${BASE}${path}`, { method: paid ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${credential}`, ...(paid ? { 'Content-Type': 'application/json' } : {}) },
      ...(paid ? { body: JSON.stringify(payload) } : {}), redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      definitelyRejected = response.status >= 400 && response.status < 500;
      await response.body?.cancel();
      throw httpError(response.status);
    }
    return await readJson(response);
  } catch (error) {
    if (paid && !definitelyRejected) throw new ProviderError('submission_unknown', UNKNOWN);
    if (error instanceof ProviderError) throw error;
    if (signal?.aborted) throw new ProviderError('cancelled', '查询已取消，可稍后继续查询同一视频任务。');
    throw new ProviderError(timedOut ? 'timeout' : 'connection', '视频任务查询暂时中断，可稍后继续查询同一任务。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
export async function createRotation(input: RotationInput, env: RotationEnv, signal?: AbortSignal): Promise<{ remoteId: string; model: string }> {
  const validated = validateRotationInput(input), model = rotationModel(env);
  const output = await request('/contents/generations/tasks', env, {
    model, content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: validated.image }, role: 'first_frame' }],
    resolution: '720p', ratio: '9:16', duration: 5, camera_fixed: true, watermark: false,
  }, signal);
  if (!object(output) || typeof output.id !== 'string' || !TASK_ID.test(output.id)) throw new ProviderError('submission_unknown', UNKNOWN);
  return { remoteId: output.id, model };
}
export async function queryRotation(remoteId: string, env: RotationEnv, signal?: AbortSignal): Promise<RotationStatus> {
  const id = taskId(remoteId), output = await request(`/contents/generations/tasks/${encodeURIComponent(id)}`, env, undefined, signal);
  if (!object(output) || output.id !== id) invalidResponse();
  if (output.status === 'queued' || output.status === 'running') return { status: output.status };
  if (output.status === 'succeeded') {
    if (!object(output.content)) invalidResponse();
    return { status: 'succeeded', videoUrl: mediaUrl(output.content.video_url) };
  }
  if (output.status === 'failed' || output.status === 'cancelled') return { status: 'failed', message: '视频服务未能完成这次生成，请先核对服务商任务记录。' };
  if (output.status === 'expired') return { status: 'expired', message: '这条视频任务已过期，请查看之前保存的结果。' };
  invalidResponse();
}
export async function downloadRotation(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const safeUrl = mediaUrl(url);
  if (signal?.aborted) throw new ProviderError('cancelled', '视频下载已取消，可稍后取回同一任务。');
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 90000);
  try {
    // CDN requests deliberately carry neither provider authentication nor cookies.
    const response = await fetch(safeUrl, { redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal });
    if (response.status !== 200) { await response.body?.cancel(); throw new ProviderError('download', '视频尚未成功下载，可稍后取回同一任务。'); }
    const declared = Number(response.headers.get('content-length'));
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if ((Number.isFinite(declared) && declared > MAX_VIDEO) || (type && type !== 'video/mp4' && type !== 'application/octet-stream')) {
      await response.body?.cancel(); invalidResponse();
    }
    if (!response.body) invalidResponse();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_VIDEO) { await reader.cancel(); throw new ProviderError('video_too_large', '视频超过 32 MB，未保存；可以查询同一任务后重试取回。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (size < 16 || String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') invalidResponse();
    const box = new DataView(bytes.buffer).getUint32(0);
    if (box < 16 || box > size || box > 4096 || box % 4 !== 0) invalidResponse();
    const brands = ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'cmfc', 'cmfs'];
    let accepted = brands.includes(String.fromCharCode(...bytes.slice(8, 12)));
    for (let position = 16; !accepted && position + 4 <= box; position += 4) accepted = brands.includes(String.fromCharCode(...bytes.slice(position, position + 4)));
    if (!accepted) invalidResponse();
    return bytes;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(signal?.aborted ? 'cancelled' : 'download', '视频下载暂时中断，可以稍后取回同一任务。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
