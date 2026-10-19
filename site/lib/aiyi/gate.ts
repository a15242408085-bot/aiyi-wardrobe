export type Kind = 'recognition' | 'tryOn';
export type Bindings = {
  DB: D1Database; BUCKET: R2Bucket;
  AIYI_ACCESS_CODE: string; AIYI_RECOGNITION_KEY: string; AIYI_IMAGE_KEY: string;
  AIYI_RECOGNITION_MODEL?: string; AIYI_IMAGE_MODEL?: string;
};
export type Job = { id: string; owner_hash: string; kind: Kind; status: 'running' | 'succeeded' | 'failed'; payload_hash: string; result_key: string | null; error: string | null; created_at: number; updated_at: number };
export const GLOBAL_LIMIT = { recognition: 30, tryOn: 12 } as const;
export const CLIENT_LIMIT = { recognition: 8, tryOn: 3 } as const;
export const MAX_JOB_AGE = 12 * 60 * 1000;
export const RESULT_AGE = 7 * 24 * 60 * 60 * 1000;
export class GateError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export async function digest(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function checkOrigin(req: Request) {
  if (req.headers.get('sec-fetch-site') === 'cross-site') throw new GateError(403, 'origin', '请从爱衣橱网页内操作。');
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) throw new GateError(403, 'origin', '请从爱衣橱网页内操作。');
}
export async function authorize(req: Request, env: Bindings, clientId: unknown): Promise<string> {
  checkOrigin(req);
  if (!env.DB || !env.BUCKET || !env.AIYI_ACCESS_CODE) throw new GateError(503, 'not_configured', '线上服务正在配置，请稍后再试。');
  const now = Date.now(), windowId = Math.floor(now / 600000);
  const ip = req.headers.get('cf-connecting-ip') || 'shared';
  const id = `access:${windowId}:${await digest(ip)}`;
  const attempts = await env.DB.prepare('SELECT attempts FROM access_attempts WHERE id=?').bind(id).first<{attempts: number}>();
  if ((attempts?.attempts || 0) >= 10) throw new GateError(429, 'access_rate', '口令尝试过多，请 10 分钟后再试。');
  const supplied = req.headers.get('x-aiyi-code') || '';
  const a = await digest(supplied.slice(0, 129)), b = await digest(env.AIYI_ACCESS_CODE);
  let mismatch = 0; for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  if (mismatch || supplied.length < 8 || supplied.length > 128) {
    const result = await env.DB.prepare('INSERT INTO access_attempts (id, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(id, now + 1200000).first<{attempts: number}>();
    if ((result?.attempts || 0) >= 10) throw new GateError(429, 'access_rate', '口令尝试过多，请 10 分钟后再试。');
    throw new GateError(401, 'access', '请输入正确的体验口令。');
  }
  if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{32,80}$/.test(clientId)) throw new GateError(400, 'client', '浏览器标识无效，请刷新网页。');
  return digest(`${env.AIYI_ACCESS_CODE}|${clientId}`);
}
export function validRequestId(id: unknown): id is string { return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id); }
export async function quota(db: D1Database, owner: string) {
  const rows = await db.prepare('SELECT kind, COUNT(*) AS total, SUM(CASE WHEN owner_hash=? THEN 1 ELSE 0 END) AS mine FROM ai_jobs GROUP BY kind').bind(owner).all<{kind: Kind; total: number; mine: number}>();
  const remaining = { recognition: CLIENT_LIMIT.recognition as number, tryOn: CLIENT_LIMIT.tryOn as number };
  for (const row of rows.results) if (row.kind in remaining) remaining[row.kind] = Math.max(0, Math.min(GLOBAL_LIMIT[row.kind] - row.total, CLIENT_LIMIT[row.kind] - row.mine));
  return { remaining, limits: CLIENT_LIMIT, totalLimits: GLOBAL_LIMIT };
}
export async function stale(db: D1Database) {
  await db.prepare("UPDATE ai_jobs SET status='failed', error=?, updated_at=? WHERE status='running' AND created_at<?").bind('连接中断或处理超时，可能已产生模型费用。请先查询结果，不要反复提交。', Date.now(), Date.now() - MAX_JOB_AGE).run();
}
/** Reject large uploads while generation is active; reserve still owns the atomic paid slot. */
export async function assertUploadAvailable(db: D1Database) {
  await stale(db);
  if (await db.prepare("SELECT id FROM ai_jobs WHERE status='running' LIMIT 1").first()) {
    throw new GateError(429, 'busy_global', '当前有任务正在生成，请稍后再试。已提交的任务请查询结果，无需重新上传。');
  }
}
export async function getJob(db: D1Database, id: string, owner: string) {
  await stale(db);
  const row = await db.prepare('SELECT * FROM ai_jobs WHERE id=? AND owner_hash=?').bind(id, owner).first<Job>();
  if (!row) throw new GateError(404, 'not_found', '没有找到这条任务，请确认正在使用原浏览器。');
  return row;
}
export async function reserve(db: D1Database, id: string, owner: string, kind: Kind, payloadHash: string): Promise<{job: Job; created: boolean}> {
  await stale(db);
  const previous = await db.prepare('SELECT * FROM ai_jobs WHERE id=?').bind(id).first<Job>();
  if (previous) {
    if (previous.owner_hash !== owner) throw new GateError(404, 'not_found', '任务不存在。');
    if (previous.payload_hash !== payloadHash || previous.kind !== kind) throw new GateError(409, 'request_conflict', '任务编号已使用，请勿复用编号提交不同内容。');
    return { job: previous, created: false };
  }
  const now = Date.now();
  // One INSERT ... SELECT gives an atomic quota check and reservation in D1.
  const row = await db.prepare(`INSERT INTO ai_jobs (id,owner_hash,kind,status,payload_hash,created_at,updated_at)
    SELECT ?,?,?,'running',?,?,?
    WHERE (SELECT COUNT(*) FROM ai_jobs WHERE kind=?)<?
      AND (SELECT COUNT(*) FROM ai_jobs WHERE kind=? AND owner_hash=?)<?
      AND NOT EXISTS (SELECT 1 FROM ai_jobs WHERE owner_hash=? AND status='running')
      AND (SELECT COUNT(*) FROM ai_jobs WHERE status='running')<1
    ON CONFLICT(id) DO NOTHING RETURNING *`).bind(id, owner, kind, payloadHash, now, now, kind, GLOBAL_LIMIT[kind], kind, owner, CLIENT_LIMIT[kind], owner).first<Job>();
  if (row) return { job: row, created: true };
  const raced = await db.prepare('SELECT * FROM ai_jobs WHERE id=? AND owner_hash=?').bind(id, owner).first<Job>();
  if (raced && raced.kind === kind && raced.payload_hash === payloadHash) return { job: raced, created: false };
  if (await db.prepare("SELECT id FROM ai_jobs WHERE owner_hash=? AND status='running' LIMIT 1").bind(owner).first()) throw new GateError(409, 'busy', '上一条任务还在处理中，请等待或查询结果。');
  if (await db.prepare("SELECT id FROM ai_jobs WHERE status='running' LIMIT 1").first()) throw new GateError(429, 'busy_global', '当前有体验者正在生成，请稍后再试。');
  throw new GateError(429, 'quota', '本轮测试次数已用完，请联系发给你网址的人增加额度。');
}
export async function finishJob(db: D1Database, id: string, owner: string, key: string) {
  await db.prepare("UPDATE ai_jobs SET status='succeeded',result_key=?,error=NULL,updated_at=? WHERE id=? AND owner_hash=?").bind(key, Date.now(), id, owner).run();
}
export async function failJob(db: D1Database, id: string, owner: string, message: string) {
  await db.prepare("UPDATE ai_jobs SET status='failed',error=?,updated_at=? WHERE id=? AND owner_hash=? AND status='running'").bind(message.slice(0, 300), Date.now(), id, owner).run();
}
export async function cleanup(env: Bindings) {
  const now = Date.now();
  const old = await env.DB.prepare('SELECT id,result_key FROM ai_jobs WHERE result_key IS NOT NULL AND created_at<? LIMIT 10').bind(now - RESULT_AGE).all<{id: string; result_key: string}>();
  for (const row of old.results) {
    await env.BUCKET.delete(row.result_key);
    await env.DB.prepare('UPDATE ai_jobs SET result_key=NULL WHERE id=? AND result_key=?').bind(row.id, row.result_key).run();
  }
  await env.DB.prepare('DELETE FROM access_attempts WHERE expires_at<?').bind(now).run();
}
