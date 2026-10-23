/** Durable video submission metadata is saved before the one paid provider call. */
// @ts-ignore TS5097: Node tests and the Worker resolve the same TypeScript source.
import { digest, failJob, finishJob, GateError, getJob, reserve, RESULT_AGE, type Bindings, type Job } from './gate.ts';
// @ts-ignore TS5097: Native Node test imports.
import { createRotation, downloadRotation, queryRotation, rotationModel, type RotationInput } from './video-provider.ts';
// @ts-ignore TS5097: Native Node test imports.
import { ProviderError } from './providers.ts';

type Manifest = {
  version: 1; provider: 'volcengine'; model: string; createdAt: number;
  phase: 'submitting' | 'accepted' | 'unknown' | 'failed' | 'succeeded';
  remoteId?: string; message?: string; mediaKey?: string;
};
type View = { taskId: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; message?: string; needsAttention?: boolean; result?: { mediaPath: string } };
const pendingMessage = '视频已提交，正在生成。关闭页面后可继续查询这条任务。';
const unknownMessage = '提交结果尚未确认，请核对火山引擎任务记录；不要再次生成，以免重复付费。';
function metadataKey(owner: string, id: string) { return `ai-results/${owner}/${id}.rotation.json`; }
function view(id: string, status: View['status'], values: Omit<View, 'taskId' | 'status'> = {}): View { return { taskId: id, status, ...values }; }
function safeMessage(error: unknown) { return error instanceof ProviderError ? error.message : '视频结果暂未保存，请查询同一任务，不要重复生成。'; }
async function writeManifest(env: Bindings, key: string, manifest: Manifest) {
  await env.BUCKET.put(key, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' } });
}
async function readManifest(env: Bindings, owner: string, job: Job): Promise<Manifest | null> {
  const object = await env.BUCKET.get(metadataKey(owner, job.id));
  if (!object) return null;
  const row = await object.json<Manifest>();
  if (row?.version !== 1 || row.provider !== 'volcengine' || typeof row.model !== 'string') return null;
  return row;
}
function successful(id: string) { return view(id, 'succeeded', { result: { mediaPath: `/api/ai/rotation-media/${id}` } }); }
export async function createVideoJob(env: Bindings, owner: string, id: string, input: RotationInput): Promise<View> {
  if (!env.AIYI_VIDEO_KEY) throw new GateError(503, 'not_configured', '转身视频服务尚未配置。');
  const model = rotationModel(env);
  const reservation = await reserve(env.DB, id, owner, 'rotation', await digest(JSON.stringify(input)));
  if (!reservation.created) return readVideoJob(env, owner, reservation.job);
  const key = metadataKey(owner, id);
  const manifest: Manifest = { version: 1, provider: 'volcengine', model, createdAt: Date.now(), phase: 'submitting' };
  // A preparation failure cannot reach the provider. Never submit without recovery metadata.
  try {
    await writeManifest(env, key, manifest);
    await env.DB.prepare('UPDATE ai_jobs SET result_key=? WHERE id=? AND owner_hash=?').bind(key, id, owner).run();
  } catch {
    manifest.phase = 'failed'; manifest.message = '任务准备失败，未调用视频模型。请稍后重试。';
    try { await writeManifest(env, key, manifest); } catch { /* No provider call has occurred. */ }
    await failJob(env.DB, id, owner, manifest.message);
    throw new GateError(503, 'storage', '任务准备失败，未调用视频模型。请稍后重试。');
  }
  let accepted: Awaited<ReturnType<typeof createRotation>>;
  try {
    accepted = await createRotation(input, { ...env, AIYI_VIDEO_MODEL: model });
  } catch (error) {
    const unknown = !(error instanceof ProviderError) || error.code === 'submission_unknown';
    manifest.phase = unknown ? 'unknown' : 'failed';
    manifest.message = unknown ? unknownMessage : safeMessage(error);
    try { await writeManifest(env, key, manifest); } catch { /* Original submitting record remains recoverable. */ }
    if (!unknown) await failJob(env.DB, id, owner, manifest.message);
    return view(id, unknown ? 'running' : 'failed', { message: manifest.message, ...(unknown ? { needsAttention: true } : {}) });
  }
  manifest.remoteId = accepted.remoteId; manifest.phase = 'accepted';
  try { await writeManifest(env, key, manifest); }
  catch { return view(id, 'running', { message: unknownMessage, needsAttention: true }); }
  return view(id, 'queued', { message: pendingMessage });
}
export async function readVideoJob(env: Bindings, owner: string, job: Job): Promise<View> {
  if (job.owner_hash !== owner || job.kind !== 'rotation') throw new GateError(404, 'not_found', '没有找到这条转身视频任务。');
  if (job.created_at < Date.now() - RESULT_AGE) return view(job.id, 'failed', { message: '视频结果已超过 7 天保留期，请查看保存在本机的视频。' });
  const manifest = await readManifest(env, owner, job);
  if (!manifest) return view(job.id, job.status === 'failed' ? 'failed' : 'running', { message: job.error || unknownMessage, needsAttention: true });
  if (manifest.phase === 'failed') return view(job.id, 'failed', { message: manifest.message || '视频生成未完成。' });
  const key = metadataKey(owner, job.id), mediaKey = `${key}.mp4`;
  if (manifest.phase === 'succeeded' && manifest.mediaKey === mediaKey) {
    if (await env.BUCKET.head(mediaKey)) {
      if (job.status !== 'succeeded') await finishJob(env.DB, job.id, owner, key);
      return successful(job.id);
    }
    // Re-download the same accepted provider task if a media object was lost.
    manifest.phase = 'accepted'; delete manifest.mediaKey;
  }
  if (!manifest.remoteId) return view(job.id, 'running', { message: manifest.phase === 'submitting' && Date.now() - manifest.createdAt < 90000 ? '正在确认提交结果，请稍候。' : unknownMessage,
    ...(manifest.phase !== 'submitting' || Date.now() - manifest.createdAt >= 90000 ? { needsAttention: true } : {}) });
  let status: Awaited<ReturnType<typeof queryRotation>>;
  try { status = await queryRotation(manifest.remoteId, { ...env, AIYI_VIDEO_MODEL: manifest.model }); }
  catch (error) { return view(job.id, 'running', { message: safeMessage(error), needsAttention: true }); }
  if (status.status === 'queued' || status.status === 'running') return view(job.id, status.status, { message: pendingMessage });
  if (status.status === 'failed' || status.status === 'expired') {
    manifest.phase = 'failed'; manifest.message = status.message || '视频生成未完成。';
    await writeManifest(env, key, manifest); await failJob(env.DB, job.id, owner, manifest.message);
    return view(job.id, 'failed', { message: manifest.message });
  }
  if (!status.videoUrl) return view(job.id, 'running', { message: '尚未收到视频地址，请继续查询原任务。', needsAttention: true });
  try {
    const bytes = await downloadRotation(status.videoUrl);
    await env.BUCKET.put(mediaKey, bytes as Uint8Array<ArrayBuffer>, { httpMetadata: { contentType: 'video/mp4', cacheControl: 'private, no-store' } });
    manifest.phase = 'succeeded'; manifest.mediaKey = mediaKey;
    await writeManifest(env, key, manifest); await finishJob(env.DB, job.id, owner, key);
    return successful(job.id);
  } catch (error) { return view(job.id, 'running', { message: safeMessage(error), needsAttention: true }); }
}
export async function readVideoMedia(env: Bindings, owner: string, id: string): Promise<R2ObjectBody> {
  const job = await getJob(env.DB, id, owner);
  if (job.kind !== 'rotation' || job.created_at < Date.now() - RESULT_AGE) throw new GateError(404, 'not_found', '视频结果暂时不可用或已过保留期。');
  const manifest = await readManifest(env, owner, job), expected = `${metadataKey(owner, id)}.mp4`;
  if (manifest?.phase !== 'succeeded' || manifest.mediaKey !== expected) throw new GateError(409, 'not_ready', '视频还未保存完成，请查询同一任务。');
  const media = await env.BUCKET.get(expected);
  if (!media) throw new GateError(404, 'not_found', '视频结果暂时不可用，请查询同一任务。');
  return media;
}
