import { isIP } from 'node:net';
import { getServerHistoryInfo, getHistoryIdRange } from '../database/indexOptimization.js';
import { ensureIperfJobTables } from './iperfJobs.js';
import { createBadRequestResponse as bad, createSuccessResponse as ok, createUnauthorizedResponse as denied } from '../utils/errors.js';

const ID = /^[a-zA-Z0-9._:-]{1,100}$/;
const schemaReady = new WeakMap();
export function ensureAutoTables(db) {
  if(schemaReady.has(db))return schemaReady.get(db);
  const pending=initializeSchema(db).catch(error=>{schemaReady.delete(db);throw error;});
  schemaReady.set(db,pending);return pending;
}
async function initializeSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS iperf_enrollments (
    server_id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, ipv4 TEXT, ipv6 TEXT,
    status TEXT NOT NULL, error TEXT, checked_key TEXT, last_seen INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS iperf_listeners (
    job_id TEXT PRIMARY KEY, server_id TEXT NOT NULL, target_key TEXT NOT NULL,
    state TEXT NOT NULL, sources TEXT NOT NULL, expires_at INTEGER NOT NULL, error TEXT
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_iperf_listener_server_expiry ON iperf_listeners(server_id,expires_at DESC)').run();
}
function publicAddress(value, family) {
  if (value == null || value === '') return null;
  if (![4, 6].includes(family)) throw new Error('invalidPublicAddress');
  if (typeof value !== 'string' || isIP(value) !== family) throw new Error('invalidPublicAddress');
  if (family === 6 && !/^[23]/.test(value)) throw new Error('invalidPublicAddress');
  if (family === 4) {
    const [a, b] = value.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) throw new Error('invalidPublicAddress');
  }
  return value;
}
const targetKey = row => `${row.enrollment_id}|${row.ipv4 || ''}|${row.ipv6 || ''}`;
const runnerAuth = (request, env) => !!env.IPERF_REPORT_TOKEN && request.headers.get('X-Iperf-Token') === env.IPERF_REPORT_TOKEN;
let signingSecret,signingPromise;
async function signingKey(env) {
  if(signingSecret===env.API_SECRET && signingPromise)return signingPromise;
  signingSecret=env.API_SECRET;
  signingPromise=crypto.subtle.importKey('raw', new TextEncoder().encode(env.API_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return signingPromise;
}
const tokenInput = row => new TextEncoder().encode(`cfsm-iperf-node-v1:${row.server_id}:${row.enrollment_id}`);
async function nodeToken(row, env) {
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), tokenInput(row)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
async function nodeAuth(request, row, env) {
  const token = request.headers.get('X-Iperf-Node-Token') || '';
  if (!row || !env.API_SECRET || !/^[a-f0-9]{64}$/.test(token)) return false;
  return crypto.subtle.verify('HMAC', await signingKey(env), Uint8Array.from(token.match(/../g), hex => parseInt(hex, 16)), tokenInput(row));
}
async function enqueueCheck(db, row, retry = false) {
  const slot = `enroll:${targetKey(row)}${retry ? `:${crypto.randomUUID()}` : ''}`;
  await db.prepare(`INSERT OR IGNORE INTO iperf_jobs (id,server_id,source,status,duration_seconds,scheduled_slot,created_at)
    VALUES (?,?,'onboarding','queued',5,?,?)`).bind(crypto.randomUUID(), row.server_id, slot, Date.now()).run();
}

export async function handleIperfBootstrap(request, env) {
  const data = await request.json().catch(() => null);
  if (!env.API_SECRET || data?.secret !== env.API_SECRET) return denied();
  if (!env.IPERF_REPORT_TOKEN || !ID.test(data.id || '')) return bad('iperfAutoUnavailable');
  if (!await env.DB.prepare('SELECT id FROM servers WHERE id=?').bind(data.id).first()) return bad('unknownServer');
  await ensureIperfJobTables(env.DB);
  await ensureAutoTables(env.DB);
  const row = { server_id: data.id, enrollment_id: crypto.randomUUID() };
  await env.DB.prepare(`INSERT INTO iperf_enrollments (server_id,enrollment_id,status,last_seen) VALUES (?,?,'pending',?)
    ON CONFLICT(server_id) DO UPDATE SET enrollment_id=excluded.enrollment_id,status='pending',checked_key=NULL,error=NULL,last_seen=excluded.last_seen`)
    .bind(row.server_id, row.enrollment_id, Date.now()).run();
  await env.DB.prepare("DELETE FROM iperf_targets WHERE server_id=? AND source='auto'").bind(row.server_id).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO iperf_schedules (server_id,enabled,time_beijing,time_beijing_day,duration_seconds,updated_at)
    VALUES (?,0,'21:30','11:30',10,?)`).bind(row.server_id, Date.now()).run();
  return ok({ token: await nodeToken(row, env), server_id: row.server_id });
}

export async function handleIperfNode(request, env) {
  const data = await request.json().catch(() => null);
  if (!data || !ID.test(data.id || '')) return denied();
  await ensureIperfJobTables(env.DB);
  await ensureAutoTables(env.DB);
  const row = await env.DB.prepare('SELECT * FROM iperf_enrollments WHERE server_id=?').bind(data.id).first();
  if (!await nodeAuth(request, row, env)) return denied();
  const server = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(data.id).first();
  if (!server) return bad('unknownServer');
  // 心跳只校验公网地址，不读取/转换整份系统指标，降低免费 Worker 每次 CPU 消耗。
  const info=await getServerHistoryInfo(env.DB,data.id,server);
  let metrics=null;
  if(info.partitionId){const range=getHistoryIdRange(info.partitionId,info.startTimestamp>0?info.startTimestamp:null);
    metrics=await env.DB.prepare('SELECT ip_v4,ip_v6 FROM metrics_history WHERE id>=? AND id<=? ORDER BY id DESC LIMIT 1').bind(range.startId,range.endId).first();
  }
  let ipv4, ipv6;
  try { ipv4 = publicAddress(data.ipv4, 4); ipv6 = publicAddress(data.ipv6, 6); } catch { return bad('invalidPublicAddress'); }
  const now = Date.now();
  let error = typeof data.error === 'string' ? data.error.slice(0, 200) : null;
  if (!error && ((!ipv4 && !ipv6) || (ipv4 && ipv4 !== metrics?.ip_v4) || (ipv6 && ipv6 !== metrics?.ip_v6))) error = '等待探针上报匹配的公网地址';
  const current = { ...row, ipv4, ipv6 };
  const checked = row.checked_key === targetKey(current);
  const status = error ? error === '等待探针上报匹配的公网地址' ? 'pending' : 'blocked' : checked ? 'ready' : row.status === 'blocked' && row.ipv4 === ipv4 && row.ipv6 === ipv6 ? 'blocked' : 'pending';
  await env.DB.prepare('UPDATE iperf_enrollments SET ipv4=?,ipv6=?,status=?,error=?,last_seen=? WHERE server_id=?')
    .bind(ipv4, ipv6, status, error || (status === 'blocked' ? row.error : null), now, data.id).run();
  if (status === 'ready') {
    await env.DB.prepare(`INSERT INTO iperf_targets VALUES (?,'auto',?) ON CONFLICT(server_id) DO UPDATE SET last_seen=excluded.last_seen`)
      .bind(data.id, now).run();
  } else {
    await env.DB.prepare("DELETE FROM iperf_targets WHERE server_id=? AND source='auto'").bind(data.id).run();
    if (!error && status === 'pending') await enqueueCheck(env.DB, current);
  }
  if (data.session && /^[a-f0-9-]{36}$/.test(data.session.job_id || '') && ['ready', 'stopped', 'failed'].includes(data.session.state)) {
    const session = await env.DB.prepare('SELECT * FROM iperf_listeners WHERE job_id=? AND server_id=?').bind(data.session.job_id, data.id).first();
    if (session && ((session.state === 'preparing' && ['ready', 'failed'].includes(data.session.state)) ||
      (['stop_requested', 'ready', 'preparing'].includes(session.state) && ['stopped', 'failed'].includes(data.session.state)))) {
      await env.DB.prepare('UPDATE iperf_listeners SET state=?,error=? WHERE job_id=?').bind(data.session.state,
        typeof data.session.error === 'string' ? data.session.error.slice(0, 200) : null, session.job_id).run();
    }
  }
  const session = await env.DB.prepare("SELECT * FROM iperf_listeners WHERE server_id=? AND state IN ('preparing','ready','stop_requested') ORDER BY expires_at DESC LIMIT 1").bind(data.id).first();
  if (!session) return ok({ command: 'idle' });
  const job = await env.DB.prepare('SELECT status FROM iperf_jobs WHERE id=?').bind(session.job_id).first();
  const stop = session.state === 'stop_requested' || session.expires_at <= now || job?.status !== 'running' || session.target_key !== targetKey(current);
  return ok({ command: stop ? 'stop' : session.state === 'preparing' ? 'start' : 'wait', job_id: session.job_id,
    sources: JSON.parse(session.sources), expires_at: session.expires_at });
}

export async function handleIperfListener(request, env) {
  if (!runnerAuth(request, env)) return denied();
  const data = await request.json().catch(() => null);
  if (!data || !/^[a-f0-9-]{36}$/.test(data.job_id || '') || !['start', 'status', 'stop'].includes(data.action)) return bad('invalidListenerAction');
  await ensureAutoTables(env.DB);
  const job = await env.DB.prepare('SELECT * FROM iperf_jobs WHERE id=?').bind(data.job_id).first();
  if (!job || job.status !== 'running') return bad('iperfJobNotRunning');
  if (data.action === 'start') {
    const row = await env.DB.prepare('SELECT * FROM iperf_enrollments WHERE server_id=?').bind(job.server_id).first();
    if (!row || row.last_seen < Date.now() - 5 * 60_000 || (!row.ipv4 && !row.ipv6)) return bad('nodeNotReady');
    let sources;
    try {
      if (!Array.isArray(data.sources) || data.sources.length < 1 || data.sources.length > 2) throw new Error();
      sources = data.sources.map(ip => publicAddress(ip, isIP(ip)));
      if (sources.some(ip => !ip) || new Set(sources.map(isIP)).size !== sources.length) throw new Error();
    } catch { return bad('invalidSources'); }
    await env.DB.prepare(`INSERT OR IGNORE INTO iperf_listeners (job_id,server_id,target_key,state,sources,expires_at)
      VALUES (?,?,?,'preparing',?,?)`).bind(job.id, job.server_id, targetKey(row), JSON.stringify(sources), Date.now() + 600_000).run();
  }
  if (data.action === 'stop') await env.DB.prepare("UPDATE iperf_listeners SET state='stop_requested' WHERE job_id=? AND state IN ('preparing','ready')").bind(job.id).run();
  const session = await env.DB.prepare('SELECT state,error FROM iperf_listeners WHERE job_id=?').bind(job.id).first();
  return ok(session || { state: 'missing' });
}

export async function getIperfAutoTarget(db, id) {
  await ensureAutoTables(db);
  const row = await db.prepare('SELECT * FROM iperf_enrollments WHERE server_id=?').bind(id).first();
  return row && row.last_seen > Date.now() - 5 * 60_000 && (row.ipv4 || row.ipv6) ? { id, ipv4: row.ipv4, ipv6: row.ipv6, port: 5202, transport: 'worker' } : null;
}
export async function finishIperfAutoCheck(db, job, status, error) {
  if (job?.source !== 'onboarding') return;
  await ensureAutoTables(db);
  const row = await db.prepare('SELECT * FROM iperf_enrollments WHERE server_id=?').bind(job.server_id).first();
  const listener = await db.prepare('SELECT * FROM iperf_listeners WHERE job_id=?').bind(job.id).first();
  if (!row || (listener && listener.target_key !== targetKey(row)) || (!listener && !job.scheduled_slot?.startsWith(`enroll:${targetKey(row)}`))) return;
  const ready = status === 'completed' && listener?.state === 'stopped';
  await db.prepare('UPDATE iperf_enrollments SET status=?,checked_key=?,error=? WHERE server_id=?')
    .bind(ready ? 'ready' : 'blocked', ready ? targetKey(row) : null, ready ? null : error || '公网接入检查失败', row.server_id).run();
  if (ready) await db.prepare(`INSERT INTO iperf_targets VALUES (?,'auto',?) ON CONFLICT(server_id) DO UPDATE SET last_seen=excluded.last_seen`)
    .bind(row.server_id, Date.now()).run();
}
export async function listIperfEnrollments(db) {
  await ensureAutoTables(db);
  return (await db.prepare('SELECT server_id,status,error,last_seen FROM iperf_enrollments').all()).results || [];
}
export async function retryIperfEnrollment(db, id) {
  await ensureAutoTables(db);
  const row = await db.prepare('SELECT * FROM iperf_enrollments WHERE server_id=?').bind(id).first();
  if (!row || row.last_seen < Date.now() - 5 * 60_000) return bad('nodeNotReady');
  if (await db.prepare("SELECT id FROM iperf_jobs WHERE server_id=? AND status IN ('queued','running') LIMIT 1").bind(id).first()) return bad('iperfJobAlreadyPending');
  await db.prepare("UPDATE iperf_enrollments SET status='pending',error=NULL,checked_key=NULL WHERE server_id=?").bind(id).run();
  await enqueueCheck(db, row, true);
  return ok({ success: true });
}
