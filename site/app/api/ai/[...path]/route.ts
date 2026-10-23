import { env as runtimeEnv } from 'cloudflare:workers';
import { assertUploadAvailable, authorize, checkOrigin, cleanup, digest, failJob, finishJob, GateError, getJob, quota, reserve, RESULT_AGE, validRequestId, type Bindings, type Job, type Kind } from '../../../../lib/aiyi/gate';
import { recognize, tryOn, validateRecognitionInput, validateTryOnInput, ProviderError } from '../../../../lib/aiyi/providers';

import { createVideoJob, readVideoJob, readVideoMedia } from '../../../../lib/aiyi/video-jobs';
import { validateRotationInput } from '../../../../lib/aiyi/video-provider';

const env = () => runtimeEnv as unknown as Bindings;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'X-Aiyi-Code', 'Referrer-Policy': 'no-referrer' };
function json(value: unknown, status = 200) { return Response.json(value, { status, headers }); }
function problem(error: unknown) {
  if (error instanceof GateError) return json({ error: error.code, message: error.message }, error.status);
  if (error instanceof ProviderError) return json({ error: error.code, message: error.message }, 400);
  return json({ error: 'unavailable', message: '线上服务暂时无法处理，请稍后查询。' }, 503);
}
async function readInput(request: Request) {
  const declared = Number(request.headers.get('content-length'));
  const max = 15 * 1024 * 1024;
  if (Number.isFinite(declared) && declared > max) throw new GateError(413, 'large', '图片合计过大，请选择尺寸更小的图片。');
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new GateError(415, 'format', '请使用网页提交图片。');
  const reader = request.body?.getReader(); if (!reader) throw new GateError(400, 'body', '缺少上传内容。');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new GateError(413, 'large', '图片合计过大，请选择尺寸更小的图片。'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let result: unknown;
  try { result = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new GateError(400, 'json', '请求格式不正确。'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new GateError(400, 'json', '请求格式不正确。');
  return result as Record<string, unknown>;
}
async function viewJob(bindings: Bindings, job: Job) {
  if (job.status === 'succeeded') {
    if (!job.result_key || job.created_at < Date.now() - RESULT_AGE) return { taskId: job.id, status: 'failed', message: '服务端结果已超过 7 天保留期，请查看之前下载或保存在本机的图片。' };
    const object = await bindings.BUCKET.get(job.result_key);
    if (!object) return { taskId: job.id, status: 'failed', message: '结果文件暂时不可用，请查看已保存的本机结果。' };
    return { taskId: job.id, status: 'succeeded', result: await object.json() };
  }
  return { taskId: job.id, status: job.status, ...(job.error ? { message: job.error } : {}) };
}
export async function GET(request: Request) {
  try {
    const url = new URL(request.url), bindings = env(); checkOrigin(request);
    const configured = !!(bindings.DB && bindings.BUCKET && bindings.AIYI_ACCESS_CODE && bindings.AIYI_RECOGNITION_KEY && bindings.AIYI_IMAGE_KEY);
    if (url.pathname.endsWith('/status') && !request.headers.get('x-aiyi-code')) return json({ authorized: false, configured, rotationConfigured: !!bindings.AIYI_VIDEO_KEY });
    const owner = await authorize(request, bindings, url.searchParams.get('clientId'));
    await cleanup(bindings);
    if (url.pathname.endsWith('/status')) return json({ authorized: true, configured, rotationConfigured: !!bindings.AIYI_VIDEO_KEY, ...await quota(bindings.DB, owner) });
    const videoMatch = url.pathname.match(/^\/api\/ai\/(rotation-tasks|rotation-media)\/([^/]+)$/);
    if (videoMatch && validRequestId(videoMatch[2])) {
      if (videoMatch[1] === 'rotation-media') {
        const media = await readVideoMedia(bindings, owner, videoMatch[2]);
        return new Response(media.body, { headers: { ...headers, 'Content-Type': 'video/mp4', 'Content-Length': String(media.size), 'Content-Disposition': 'attachment; filename=rotation.mp4' } });
      }
      return json(await readVideoJob(bindings, owner, await getJob(bindings.DB, videoMatch[2], owner)));
    }
    const match = url.pathname.match(/^\/api\/ai\/tasks\/([^/]+)$/);
    if (!match || !validRequestId(match[1])) throw new GateError(404, 'route', '接口不存在。');
    const job = await getJob(bindings.DB, match[1], owner);
    return json(job.kind === 'rotation' ? await readVideoJob(bindings, owner, job) : await viewJob(bindings, job));
  } catch (error) { return problem(error); }
}
export async function POST(request: Request) {
  try {
    const bindings = env(), path = new URL(request.url).pathname;
    checkOrigin(request);
    if (!['/api/ai/recognize', '/api/ai/try-on', '/api/ai/rotation'].includes(path)) throw new GateError(404, 'route', '接口不存在。');
    // Verify invitation before accepting a potentially large image body.
    await authorize(request, bindings, 'preflight-client-id-not-used-for-ownership');
    // Existing tasks are recovered with GET; do not buffer another image upload while busy.
    await assertUploadAvailable(bindings.DB);
    const body = await readInput(request);
    const owner = await authorize(request, bindings, body.clientId);
    if (!validRequestId(body.requestId)) throw new GateError(400, 'request_id', '任务编号无效，请刷新页面。');
    if (path === '/api/ai/rotation') return json(await createVideoJob(bindings, owner, body.requestId, validateRotationInput(body)));
    if (!bindings.AIYI_RECOGNITION_KEY || !bindings.AIYI_IMAGE_KEY) throw new GateError(503, 'not_configured', '模型服务尚未配置完成。');
    const kind: Kind = path.endsWith('/recognize') ? 'recognition' : 'tryOn';
    const input = kind === 'recognition' ? validateRecognitionInput(body) : validateTryOnInput(body);
    const reservation = await reserve(bindings.DB, body.requestId, owner, kind, await digest(JSON.stringify(input)));
    if (!reservation.created) {
      const existing = await viewJob(bindings, reservation.job);
      const event = existing.status === 'succeeded' ? { type: 'completed', taskId: existing.taskId, result: 'result' in existing ? existing.result : undefined }
        : existing.status === 'failed' ? { type: 'failed', taskId: existing.taskId, message: 'message' in existing ? existing.message : '任务失败。' }
          : { type: 'started', taskId: existing.taskId, alreadyRunning: true };
      return new Response(JSON.stringify(event) + '\n', { headers: { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
    }
    const id = reservation.job.id, abort = new AbortController(), encoder = new TextEncoder();
    let closed = false, heartbeat: ReturnType<typeof setInterval> | undefined;
    const timer = setTimeout(() => abort.abort(), 10 * 60 * 1000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (message: unknown) => { if (!closed) { try { controller.enqueue(encoder.encode(JSON.stringify(message) + '\n')); } catch { closed = true; } } };
        send({ type: 'started', taskId: id });
        heartbeat = setInterval(() => send({ type: 'heartbeat', taskId: id }), 10000);
        // Keeping this response stream open keeps the Worker invocation alive.
        // No fire-and-forget waitUntil task and no automatic paid request retry.
        void (async () => {
          try {
            const result = kind === 'recognition'
              ? await recognize(input as Parameters<typeof recognize>[0], bindings, abort.signal)
              : await tryOn(input as Parameters<typeof tryOn>[0], bindings, abort.signal);
            const key = `ai-results/${owner}/${id}.json`;
            await bindings.BUCKET.put(key, JSON.stringify(result), { httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' } });
            await finishJob(bindings.DB, id, owner, key);
            send({ type: 'completed', taskId: id, result });
          } catch (error) {
            const message = error instanceof ProviderError ? error.message : abort.signal.aborted ? '连接中断或处理超时，可能已产生模型费用。请查询任务结果，勿反复提交。' : '生成未完成，请先查询结果。不要重复点击，以免多次调用模型。';
            try { await failJob(bindings.DB, id, owner, message); } catch { /* Stale task recovery handles interrupted storage writes. */ }
            send({ type: 'failed', taskId: id, code: error instanceof ProviderError ? error.code : 'generation_failed', message });
          } finally {
            clearTimeout(timer); clearInterval(heartbeat);
            try { await cleanup(bindings); } catch { /* Cleanup never changes a generation result. */ }
            if (!closed) { closed = true; controller.close(); }
          }
        })();
      },
      cancel() { closed = true; clearTimeout(timer); clearInterval(heartbeat); abort.abort(); },
    });
    return new Response(stream, { headers: { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' } });
  } catch (error) { return problem(error); }
}
