/** Official Ark video tasks. A paid POST is never retried automatically. */
// @ts-ignore TS5097: Native Node tests load this source directly; the Worker bundler also resolves it.
import { ProviderError, validateRecognitionInput } from './providers.ts';

export type RotationEnv = { AIYI_VIDEO_KEY?: string; AIYI_VIDEO_MODEL?: string; AIYI_VIDEO_ASSETS?: string };
export type RotationSourceId = `hq-model-0${1 | 2 | 3 | 4 | 5 | 6}`;
export type RotationInput = { image: string; sourceId?: never } | { sourceId: RotationSourceId; image?: never };
export type RotationStatus = { status: 'queued' | 'running' | 'succeeded' | 'failed' | 'expired'; videoUrl?: string; message?: string };
export type RotationMetadata = { modelLabel: string; duration: number; resolution: string; approvedSourceIds?: RotationSourceId[]; requiresApprovedPortrait?: true };
const BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seedance-1-0-pro-250528';
const DURATION = 5;
const RESOLUTION = '720p';
const MAX_JSON = 128 * 1024;
const MAX_VIDEO = 32 * 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9_-]{1,160}$/;
// Absolute end assertions also reject JavaScript's special trailing-newline `$` case.
const SOURCE_ID = /^hq-model-0[1-6](?![\s\S])/;
const ASSET_URI = /^asset:\/\/asset-[0-9]{14}-[A-Za-z0-9]{1,32}(?![\s\S])/;
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
function seedance2(model: string): boolean { return /^doubao-seedance-2-0(?:-|$)/.test(model); }
function approvedAssets(env: RotationEnv): Partial<Record<RotationSourceId, string>> {
  if (env.AIYI_VIDEO_ASSETS === undefined) return {};
  const invalid = () => new ProviderError('configuration_error', '可信模特素材配置不正确，请联系网站管理员。');
  if (typeof env.AIYI_VIDEO_ASSETS !== 'string' || env.AIYI_VIDEO_ASSETS.length > 4096) throw invalid();
  let value: unknown;
  try { value = JSON.parse(env.AIYI_VIDEO_ASSETS); } catch { throw invalid(); }
  if (!object(value) || Object.entries(value).some(([id, uri]) => !SOURCE_ID.test(id) || typeof uri !== 'string' || !ASSET_URI.test(uri))) throw invalid();
  return value;
}
export function rotationMetadata(env: RotationEnv): RotationMetadata {
  const model = env.AIYI_VIDEO_MODEL ?? DEFAULT_MODEL;
  let modelLabel = '视频生成服务';
  if (typeof model === 'string') {
    if (/^doubao-seedance-2-0-fast(?:-|$)/.test(model)) modelLabel = 'Seedance 2.0 Fast';
    else if (/^doubao-seedance-2-0-mini(?:-|$)/.test(model)) modelLabel = 'Seedance 2.0 Mini';
    else if (seedance2(model)) modelLabel = 'Seedance 2.0';
    else if (/^doubao-seedance-1-0-pro-fast(?:-|$)/.test(model)) modelLabel = 'Seedance 1.0 Fast';
    else if (/^doubao-seedance-1-0-pro(?:-|$)/.test(model)) modelLabel = 'Seedance 1.0';
  }
  // A malformed configuration must never make the public status endpoint leak its contents.
  // Only exact catalog originals are approved; a try-on result is a different image.
  if (typeof model === 'string' && seedance2(model)) {
    let approvedSourceIds: RotationSourceId[] = [];
    try { approvedSourceIds = (Object.keys(approvedAssets(env)) as RotationSourceId[]).sort(); } catch { /* Fail closed in public metadata. */ }
    return { modelLabel, duration: DURATION, resolution: RESOLUTION, requiresApprovedPortrait: true, approvedSourceIds };
  }
  // Expose presentation metadata only, never a key, asset URI or private endpoint ID.
  return { modelLabel, duration: DURATION, resolution: RESOLUTION };
}
export function validateRotationInput(body: unknown): RotationInput {
  if (object(body) && 'sourceId' in body) {
    if ('image' in body || typeof body.sourceId !== 'string' || !SOURCE_ID.test(body.sourceId)) {
      throw new ProviderError('invalid_request', '请选择有效的模特原图，不可同时提交图片与模特编号。');
    }
    return { sourceId: body.sourceId as RotationSourceId };
  }
  return validateRecognitionInput(body);
}
/** Call before reserving a new paid job; unknown catalog sources never consume quota. */
export function resolveRotationSource(input: RotationInput, env: RotationEnv): string {
  const validated = validateRotationInput(input);
  if (validated.sourceId === undefined) return validated.image;
  const source = approvedAssets(env)[validated.sourceId];
  if (!source) throw new ProviderError('portrait_required', '这张模特原图尚未完成平台素材入库，请联系管理员完成审核后再生成。本次未提交视频任务。');
  return source;
}
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
function knownProviderError(value: unknown): ProviderError | undefined {
  if (!object(value) || typeof value.code !== 'string') return undefined;
  const code = value.code;
  // Match documented codes only. Upstream messages may contain credentials or private URLs.
  if (code === 'InputImageSensitiveContentDetected.PrivacyInformation' || code === 'InputVideoSensitiveContentDetected.PrivacyInformation') {
    return new ProviderError('portrait_required', '当前图片未通过视频平台的人像素材验证。请使用平台可信虚拟人像或已完成授权的人像素材。');
  }
  if (code === 'ModelNotOpen' || code === 'OperationDenied.ServiceNotOpen') {
    return new ProviderError('model_not_open', '当前账号尚未开通所选视频模型，请在火山方舟控制台开通后再生成。');
  }
  if (code === 'InvalidEndpointOrModel.ModelIDAccessDisabled') {
    return new ProviderError('endpoint_required', '当前账号需要使用专属接入点，请联系网站管理员配置有权限的接入点。');
  }
  if (code === 'InvalidEndpointOrModel.NotFound' || code === 'InvalidEndpoint.ClosedEndpoint') {
    return new ProviderError('model_unavailable', '视频模型或接入点不可用，请联系网站管理员检查模型设置和访问权限。');
  }
  if (['InvalidParameter.UnsupportedParameter', 'InvalidParameter.TaskTypeConstraint', 'InvalidParameter.TaskTypeMismatch', 'InvalidParameter', 'MissingParameter'].includes(code)) {
    return new ProviderError('unsupported_request', '当前视频模型不支持这组生成参数，请联系网站管理员检查设置。');
  }
  if (['InputImageSensitiveContentDetected', 'InputVideoSensitiveContentDetected', 'InputTextSensitiveContentDetected', 'InputImageSensitiveContentDetected.PolicyViolation', 'InputVideoSensitiveContentDetected.PolicyViolation', 'InputTextSensitiveContentDetected.PolicyViolation'].includes(code)) {
    return new ProviderError('content_rejected', '视频平台未接受这次输入素材，请检查图片及使用权限后再生成。');
  }
  if (code === 'OutputVideoSensitiveContentDetected' || code === 'OutputVideoSensitiveContentDetected.PolicyViolation') {
    return new ProviderError('content_rejected', '本次视频未通过平台的输出审核，未获得可用的视频结果。');
  }
  if (['AccountOverdueError', 'OperationDenied.ServiceOverdue', 'AccountQuotaExceeded', 'QuotaExceeded', 'SetLimitExceeded'].includes(code)) {
    return new ProviderError('provider_limit', '视频服务余额或额度不足，请联系网站管理员检查账户。');
  }
  if (code === 'AuthenticationError' || code === 'AccessDenied') {
    return new ProviderError('provider_access', '视频服务权限验证未通过，请联系网站管理员。');
  }
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
      if (definitelyRejected) {
        let detail: unknown;
        try { detail = await readJson(response); } catch { /* Fall back to the HTTP class, without exposing the response. */ }
        const known = object(detail) ? knownProviderError(detail.error) : undefined;
        if (known) throw known;
      } else await response.body?.cancel();
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
  const source = resolveRotationSource(input, env), model = rotationModel(env);
  const output = await request('/contents/generations/tasks', env, {
    model, content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: source }, role: 'first_frame' }],
    resolution: RESOLUTION, ratio: '9:16', duration: DURATION, watermark: false,
    ...(seedance2(model) ? { generate_audio: false } : { camera_fixed: true }),
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
  if (output.status === 'failed' || output.status === 'cancelled') return { status: 'failed', message: knownProviderError(output.error)?.message || '视频服务未能完成这次生成，请先核对服务商任务记录。' };
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
