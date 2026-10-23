(() => {
  'use strict';
  const MAX_BYTES = 45 * 1024 * 1024, CLIENT_KEY = 'aiyi-ai-client-v1';
  const clientPattern = /^[A-Za-z0-9_-]{32,80}$/;
  const requestPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function issue(message, options = {}) { return Object.assign(Error(message), options); }
  function makeClientId() {
    try { const saved = localStorage.getItem(CLIENT_KEY); if (clientPattern.test(saved || '')) return saved; } catch (_) { /* Private browsing may disable storage. */ }
    const bytes = new Uint8Array(32); globalThis.crypto.getRandomValues(bytes);
    const id = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(CLIENT_KEY, id); } catch (_) { /* The caller can retain this browser identity in memory. */ }
    return id;
  }
  function offline() { return globalThis.location && !/^https?:$/.test(location.protocol); }
  function validate({ requestId, clientId, code } = {}, needsRequest = false) {
    if (offline()) throw issue('单文件体验版需要在线网址才能使用 AI。', { code: 'offline', status: 0, apiStatus: 0 });
    if (!clientPattern.test(clientId || '')) throw issue('浏览器标识无效，请刷新网页。', { code: 'client' });
    if (needsRequest && !requestPattern.test(requestId || '')) throw issue('任务编号无效，请重新开始。', { code: 'request_id' });
    if (code != null && (typeof code !== 'string' || code.length > 500 || /[\r\n]/.test(code))) throw issue('体验码格式无效。', { code: 'access_code' });
  }
  function headers(code) { return { 'Content-Type': 'application/json', 'X-Aiyi-Code': code || '' }; }
  function safeCode(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : 'unavailable'; }
  function message(data, fallback) {
    const value = data?.message;
    if (typeof value !== 'string' || !value.trim() || value.length > 700 || /(?:sk-[a-zA-Z0-9]{8,}|ark-[a-zA-Z0-9-]{8,}|Bearer\s|<\/?(?:html|script|body)|\bat\s+\w+\s*\(|https?:\/\/)/i.test(value)) return fallback;
    return value.trim().slice(0, 500);
  }
  async function readJSON(response) {
    const declared = Number(response.headers?.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw issue('返回结果过大，请稍后查询任务。', { code: 'large', recoverable: true });
    let value;
    try {
      if (!response.body) value = JSON.parse(await response.text());
      else {
        const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0, body = '';
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) { body += decoder.decode(); break; }
            bytes += chunk.value.byteLength;
            if (bytes > MAX_BYTES) { await reader.cancel().catch(() => {}); throw issue('返回结果过大，请稍后查询任务。', { code: 'large', recoverable: true }); }
            body += decoder.decode(chunk.value, { stream: true });
          }
        } finally { reader.releaseLock(); }
        value = JSON.parse(body);
      }
    } catch (error) {
      if (error.code) throw error;
      throw issue('暂时没有收到有效结果，请稍后查询。', { status: response.status, apiStatus: response.status, code: 'response', recoverable: response.ok });
    }
    if (!response.ok) throw issue(message(value, `请求未完成（${response.status}），请稍后再试。`), { status: response.status, apiStatus: response.status, code: safeCode(value?.error || value?.code), recoverable: false });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw issue('服务返回的资料格式无效，请稍后查询。', { code: 'response', recoverable: true });
    return value;
  }
  async function status(options = {}) {
    validate(options);
    let response;
    try { response = await fetch(`/api/ai/status?clientId=${encodeURIComponent(options.clientId)}`, { headers: headers(options.code), credentials: 'omit', cache: 'no-store' }); }
    catch (_) { throw issue('暂时连不上 AI 服务，请检查网络。', { code: 'network', status: 0, apiStatus: 0 }); }
    return readJSON(response);
  }
  async function query(requestId, options = {}) {
    validate({ ...options, requestId }, true);
    let response;
    try { response = await fetch(`/api/ai/tasks/${encodeURIComponent(requestId)}?clientId=${encodeURIComponent(options.clientId)}`, { headers: headers(options.code), credentials: 'omit', cache: 'no-store' }); }
    catch (_) { throw issue('查询暂时中断，可以稍后再次查询。', { code: 'network', recoverable: true }); }
    const task = await readJSON(response);
    if (task.taskId !== requestId) throw issue('返回的任务编号不一致，请稍后查询本次任务。', { code: 'task_mismatch', recoverable: true });
    if (!['queued', 'running', 'succeeded', 'failed'].includes(task.status)) throw issue('任务状态暂时不可用，请稍后查询。', { code: 'task_status', recoverable: true });
    return task;
  }
  async function submit(kind, payload, options = {}) {
    validate(options, true);
    const path = ['recognition', 'recognize'].includes(kind) ? '/api/ai/recognize' : ['tryOn', 'try-on'].includes(kind) ? '/api/ai/try-on' : '';
    if (!path || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw issue('任务资料格式无效。', { code: 'input' });
    let response;
    try { response = await fetch(path, { method: 'POST', headers: headers(options.code), credentials: 'omit', body: JSON.stringify({ ...payload, clientId: options.clientId, requestId: options.requestId }) }); }
    catch (_) { throw issue('连接已中断，任务可能仍在处理。请查询结果，不要重复提交。', { code: 'network', recoverable: true }); }
    if (!response.ok) return readJSON(response);
    if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('application/x-ndjson')) throw issue('没有收到任务状态，请查询本次结果。', { code: 'stream', recoverable: true });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let bytes = 0, buffer = '', completed = false, result;
    async function receive(line) {
      if (!line.trim() || completed) return;
      let event; try { event = JSON.parse(line); } catch (_) { throw issue('任务连接返回异常，请查询本次结果。', { code: 'stream_json', recoverable: true }); }
      if (!event || typeof event !== 'object' || !['started', 'heartbeat', 'completed', 'failed'].includes(event.type)) throw issue('任务状态暂时无法识别，请查询本次结果。', { code: 'stream_event', recoverable: true });
      if (event.taskId !== options.requestId) throw issue('任务编号与本次提交不一致，请查询本次结果。', { code: 'task_mismatch', recoverable: true });
      if (event.type === 'failed') {
        await options.onEvent?.({ type: 'failed', taskId: event.taskId, code: safeCode(event.code), message: message(event, '这次任务没有完成，请稍后再试。') });
        throw issue(message(event, '这次任务没有完成，请稍后再试。'), { code: safeCode(event.code), recoverable: false, terminal: true });
      }
      if (event.type === 'completed') {
        if (!event.result || typeof event.result !== 'object' || Array.isArray(event.result)) throw issue('任务结果格式无效，请查询本次结果。', { code: 'result', recoverable: true });
        result = event.result; completed = true;
      }
      await options.onEvent?.(event);
    }
    try {
      while (!completed) {
        let chunk; try { chunk = await reader.read(); } catch (_) { throw issue('连接已断开，任务可能仍在处理。请查询结果，不要重复提交。', { code: 'disconnected', recoverable: true }); }
        if (chunk.value) bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) throw issue('结果过大，暂时无法接收。请查询本次任务。', { code: 'large', recoverable: true });
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) await receive(line);
        if (chunk.done) { if (buffer.trim()) await receive(buffer); break; }
      }
      if (!completed) throw issue('连接已断开，任务可能仍在处理。请查询结果，不要重复提交。', { code: 'disconnected', recoverable: true });
      return result;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  function rotationTask(task, requestId) {
    if (task.taskId !== requestId) throw issue('返回的转身任务编号不一致，请查询本次任务。', { code: 'task_mismatch', recoverable: true });
    if (!['queued', 'running', 'succeeded', 'failed'].includes(task.status)) throw issue('转身任务状态暂时不可用，请稍后查询。', { code: 'task_status', recoverable: true });
    if (task.status === 'succeeded' && task.result?.mediaPath !== `/api/ai/rotation-media/${requestId}`) throw issue('转身结果地址无效，请查询本次任务。', { code: 'media_path', recoverable: true });
    return { taskId: requestId, status: task.status, ...(task.needsAttention === true ? { needsAttention: true } : {}), ...(task.message ? { message: message(task, '转身任务暂未完成，请稍后查询。') } : {}), ...(task.status === 'succeeded' ? { result: { mediaPath: task.result.mediaPath } } : {}) };
  }
  async function createRotation(payload, options = {}) {
    validate(options, true);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw issue('请使用清晰、完整的人物照片生成转身视频。', { code: 'input', recoverable: false });
    const hasSource = Object.hasOwn(payload, 'sourceId'), hasImage = Object.hasOwn(payload, 'image');
    if (hasSource === hasImage || (hasSource ? typeof payload.sourceId !== 'string' || payload.sourceId.length !== 11 || !/^hq-model-0[1-6]$/.test(payload.sourceId) : typeof payload.image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(payload.image) || payload.image.length > 2600000)) throw issue('请选择已完成入库的模特，或使用清晰、完整的人物照片。', { code: 'input', recoverable: false });
    const input = hasSource ? { sourceId: payload.sourceId } : { image: payload.image };
    let response;
    try { response = await fetch('/api/ai/rotation', { method: 'POST', headers: headers(options.code), credentials: 'omit', body: JSON.stringify({ ...input, requestId: options.requestId, clientId: options.clientId }) }); }
    catch (_) { throw issue('连接已中断，转身任务可能已提交。请查询结果，不要重复生成。', { code: 'network', recoverable: true }); }
    try { return rotationTask(await readJSON(response), options.requestId); }
    catch (error) { if (response.status >= 500) error.recoverable = true; throw error; }
  }
  async function queryRotation(requestId, options = {}) {
    validate({ ...options, requestId }, true);
    let response;
    try { response = await fetch(`/api/ai/rotation-tasks/${encodeURIComponent(requestId)}?clientId=${encodeURIComponent(options.clientId)}`, { headers: headers(options.code), credentials: 'omit', cache: 'no-store' }); }
    catch (_) { throw issue('转身任务查询中断，可以稍后再次查询。', { code: 'network', recoverable: true }); }
    return rotationTask(await readJSON(response), requestId);
  }
  async function readRotation(mediaPath, options = {}) {
    const match = typeof mediaPath === 'string' && mediaPath.match(/^\/api\/ai\/rotation-media\/([0-9a-f-]+)$/i);
    validate({ ...options, requestId: match?.[1] }, true);
    const maximum = 32 * 1024 * 1024;
    let response;
    try { response = await fetch(`${mediaPath}?clientId=${encodeURIComponent(options.clientId)}`, { headers: headers(options.code), credentials: 'omit', cache: 'no-store' }); }
    catch (_) { throw issue('视频下载暂时中断，任务结果已保留，请再次查询。', { code: 'network', recoverable: true }); }
    if (!response.ok) return readJSON(response);
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('video/mp4')) throw issue('视频格式暂时无法读取，请再次查询。', { code: 'media_type', recoverable: true });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) throw issue('转身视频超过 32 MB，暂时无法保存。', { code: 'large', recoverable: true });
    if (!response.body) throw issue('视频内容暂时无法读取，请再次查询。', { code: 'media_empty', recoverable: true });
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maximum) throw issue('转身视频超过 32 MB，暂时无法保存。', { code: 'large', recoverable: true });
        chunks.push(chunk.value);
      }
      if (!bytes) throw issue('视频内容为空，请再次查询。', { code: 'media_empty', recoverable: true });
      return new Blob(chunks, { type: 'video/mp4' });
    } catch (error) {
      if (error.code) throw error;
      throw issue('视频下载中断，任务结果已保留，请再次查询。', { code: 'network', recoverable: true });
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  globalThis.AiyiAPI = Object.freeze({ makeClientId, status, submit, query, createRotation, queryRotation, readRotation });
})();
