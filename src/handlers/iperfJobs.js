import { deletedServerIds } from '../utils/deleteServers.js';
import { iperfAudit } from '../utils/iperfAudit.js';
import { getIperfJobResults, ensureIperfResultsTable } from './iperf.js';
import { createBadRequestResponse, createSuccessResponse, createUnauthorizedResponse } from '../utils/errors.js';
import { ensureAutoTables, finishIperfAutoCheck, getIperfAutoTarget, listIperfEnrollments, retryIperfEnrollment } from './iperfAuto.js';

const SERVER_ID = /^[a-zA-Z0-9._:-]{1,100}$/;
const BEIJING_OFFSET = 8 * 3600_000;

export async function ensureIperfJobTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS iperf_jobs (
    id TEXT PRIMARY KEY, server_id TEXT NOT NULL, source TEXT NOT NULL,
    status TEXT NOT NULL, duration_seconds INTEGER NOT NULL, scheduled_slot TEXT,
    created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
    error TEXT, result_count INTEGER
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS iperf_claim_requests (request_id TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL,server_id TEXT NOT NULL,created_at INTEGER NOT NULL)`).run();
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_iperf_job_slot ON iperf_jobs(server_id, scheduled_slot) WHERE scheduled_slot IS NOT NULL').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_iperf_job_status ON iperf_jobs(status, created_at)').run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_iperf_one_active ON iperf_jobs(server_id) WHERE status IN ('queued','running')").run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS iperf_schedules (
    server_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
    time_beijing TEXT NOT NULL DEFAULT '21:30', time_beijing_day TEXT NOT NULL DEFAULT '11:30',
    duration_seconds INTEGER NOT NULL DEFAULT 10,
    updated_at INTEGER NOT NULL
  )`).run();
  const columns = await db.prepare('PRAGMA table_info(iperf_schedules)').all();
  for (const [name, definition] of [['time_beijing_day', "TEXT NOT NULL DEFAULT '11:30'"], ['time_beijing_extra', 'TEXT DEFAULT NULL'], ['expiry_refresh_enabled','INTEGER NOT NULL DEFAULT 0']]) {
    if (!(columns.results || []).some(column => column.name === name)) {
      try { await db.prepare(`ALTER TABLE iperf_schedules ADD COLUMN ${name} ${definition}`).run(); }
      catch (error) { if (!/duplicate column name/i.test(error.message || '')) throw error; }
    }
  }
  await db.prepare(`CREATE TABLE IF NOT EXISTS iperf_targets (
    server_id TEXT PRIMARY KEY, source TEXT NOT NULL, last_seen INTEGER NOT NULL
  )`).run();
}

function validDuration(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 5 && n <= 30 ? n : null;
}

async function serverExists(db, id) {
  return !!await db.prepare('SELECT id FROM servers WHERE id = ?').bind(id).first();
}

async function targetReady(db, id, now = Date.now()) {
  return !!await db.prepare('SELECT server_id FROM iperf_targets WHERE server_id=? AND last_seen>?')
    .bind(id, now - 5 * 60_000).first();
}

export async function handleIperfAdminAction(data, env) {
  await ensureIperfJobTables(env.DB);
  const { action } = data;
  if (action === 'iperf_list') {
    const [jobs, schedules, targets, enrollments, results] = await Promise.all([
      env.DB.prepare('SELECT * FROM iperf_jobs ORDER BY created_at DESC LIMIT 100').all(),
      env.DB.prepare('SELECT * FROM iperf_schedules ORDER BY server_id').all(),
      env.DB.prepare('SELECT server_id FROM iperf_targets WHERE last_seen>?').bind(Date.now() - 5 * 60_000).all(),
      listIperfEnrollments(env.DB),
      getIperfJobResults(env.DB)
    ]);
    return createSuccessResponse({ jobs: (jobs.results || []).map(job => ({ ...job, results: results.get(job.id) || [] })), schedules: schedules.results || [], enrollments,
      ready_targets: (targets.results || []).map(row => row.server_id) });
  }
  const id = data.server_id;
  if (typeof id !== 'string' || !SERVER_ID.test(id) || !await serverExists(env.DB, id)) return createBadRequestResponse('unknownServer');
  if (action === 'iperf_onboard_retry') return retryIperfEnrollment(env.DB, id);
  if (action === 'iperf_expiry_refresh') {
    if(typeof data.enabled!=='boolean')return createBadRequestResponse('invalidIperfSchedule');
    if(data.enabled && !await targetReady(env.DB,id))return createBadRequestResponse('targetNotReadyOnDeb');
    await env.DB.prepare(`INSERT INTO iperf_schedules(server_id,enabled,time_beijing,duration_seconds,updated_at,expiry_refresh_enabled)
      VALUES (?,0,'21:30',10,?,?) ON CONFLICT(server_id) DO UPDATE SET expiry_refresh_enabled=excluded.expiry_refresh_enabled,updated_at=excluded.updated_at`)
      .bind(id,Date.now(),data.enabled?1:0).run();
    await iperfAudit(env.DB,'expiry_refresh_saved',{server_id:id,enabled:data.enabled});
    return createSuccessResponse({server_id:id,expiry_refresh_enabled:data.enabled});
  }
  const duration = validDuration(data.duration_seconds);
  if (!duration) return createBadRequestResponse('invalidDuration');
  if (action === 'iperf_trigger') {
    if (!await targetReady(env.DB, id)) return createBadRequestResponse('targetNotReadyOnDeb');
    const busy = await env.DB.prepare("SELECT id FROM iperf_jobs WHERE server_id = ? AND status IN ('queued','running') LIMIT 1").bind(id).first();
    if (busy) return createBadRequestResponse('iperfJobAlreadyPending');
    const jobId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO iperf_jobs (id,server_id,source,status,duration_seconds,created_at) VALUES (?,?,?,'queued',?,?)")
      .bind(jobId, id, 'manual', duration, Date.now()).run();
    return createSuccessResponse({ id: jobId, status: 'queued' });
  }
  if (action === 'iperf_schedule') {
    const enabled = data.enabled === true ? 1 : data.enabled === false ? 0 : null;
    const time = data.time_beijing;
    const existing = await env.DB.prepare('SELECT time_beijing_day,time_beijing_extra FROM iperf_schedules WHERE server_id=?').bind(id).first();
    const dayTime = data.time_beijing_day ?? existing?.time_beijing_day ?? '11:30';
    const extraTime = data.time_beijing_extra === undefined ? existing?.time_beijing_extra ?? null : data.time_beijing_extra === '' ? null : data.time_beijing_extra;
    const validTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (enabled === null || !validTime(time) || !validTime(dayTime) || time === dayTime || (extraTime !== null && (!validTime(extraTime) || [time, dayTime].includes(extraTime)))) return createBadRequestResponse('invalidIperfSchedule');
    if (enabled && !await targetReady(env.DB, id)) return createBadRequestResponse('targetNotReadyOnDeb');
    await env.DB.prepare(`INSERT INTO iperf_schedules (server_id,enabled,time_beijing,time_beijing_day,time_beijing_extra,duration_seconds,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET enabled=excluded.enabled,
      time_beijing=excluded.time_beijing,time_beijing_day=excluded.time_beijing_day,time_beijing_extra=excluded.time_beijing_extra,
      duration_seconds=excluded.duration_seconds,updated_at=excluded.updated_at`)
      .bind(id, enabled, time, dayTime, extraTime, duration, Date.now()).run();
    await iperfAudit(env.DB, 'schedule_saved', { server_id: id, enabled, times: [dayTime,time,extraTime], duration_seconds: duration });
    return createSuccessResponse({ server_id: id, enabled, time_beijing: time, time_beijing_day: dayTime, time_beijing_extra: extraTime, duration_seconds: duration });
  }
  return createBadRequestResponse('unknownIperfAction');
}

// 独立于日常定时：已有测速历史到期才补测，新节点和显式关闭的节点不自动耗流量。
export async function enqueueExpiredIperfJobs(db,now=Date.now()) {
  await ensureIperfJobTables(db);await ensureIperfResultsTable(db);
  const candidates=(await db.prepare(`SELECT s.server_id,s.duration_seconds,t.last_seen,
    (SELECT MIN(latest_at) FROM (SELECT MAX(tested_at) AS latest_at FROM iperf_results
      WHERE server_id=s.server_id AND source='deb' GROUP BY family)) AS oldest_family_at,
    (SELECT MAX(created_at) FROM iperf_jobs WHERE server_id=s.server_id AND source='refresh') AS last_refresh_at
    FROM iperf_schedules s JOIN servers v ON v.id=s.server_id
    LEFT JOIN iperf_targets t ON t.server_id=s.server_id WHERE s.expiry_refresh_enabled=1`).all()).results||[];
  let count=0;
  if(candidates.length)await iperfAudit(db,'expiry_refresh_checked',{checked_at:now,selection:candidates.map(c=>({server_id:c.server_id,
    oldest_family_at:c.oldest_family_at,next_due_at:c.oldest_family_at==null?null:c.oldest_family_at+72*3600000,
    last_refresh_at:c.last_refresh_at,target_last_seen:c.last_seen}))});
  for(const candidate of candidates) {
    if(candidate.oldest_family_at==null || now-candidate.oldest_family_at<=72*3600000)continue;
    const reason=!(candidate.last_seen>now-300000)?'target_not_ready'
      :candidate.last_refresh_at!=null && now-candidate.last_refresh_at<86400000?'retry_cooldown':null;
    if(reason) {
      // 24 小时冷却内无需每分钟重复写一条相同日志。
      if(reason!=='retry_cooldown')await iperfAudit(db,'expiry_refresh_skipped',{server_id:candidate.server_id,reason,oldest_family_at:candidate.oldest_family_at});
      continue;
    }
    const slot=`expiry:${Math.floor(now/86400000)}`;
    const result=await db.prepare(`INSERT OR IGNORE INTO iperf_jobs(id,server_id,source,status,duration_seconds,scheduled_slot,created_at)
      SELECT ?,?,'refresh','queued',?,?,? WHERE NOT EXISTS(SELECT 1 FROM iperf_jobs WHERE server_id=? AND status IN ('queued','running'))
      AND NOT EXISTS(SELECT 1 FROM iperf_jobs WHERE server_id=? AND source='refresh' AND created_at>?)
      AND (SELECT MIN(latest_at) FROM (SELECT MAX(tested_at) AS latest_at FROM iperf_results WHERE server_id=? AND source='deb' GROUP BY family))<?`)
      .bind(crypto.randomUUID(),candidate.server_id,candidate.duration_seconds,slot,now,candidate.server_id,candidate.server_id,now-86400000,candidate.server_id,now-72*3600000).run();
    const inserted=result.meta?.changes||0;count+=inserted;
    await iperfAudit(db,'expiry_refresh_enqueue',{server_id:candidate.server_id,oldest_family_at:candidate.oldest_family_at,inserted,slot});
  }
  return count;
}

export async function enqueueDueIperfJobs(db, now = Date.now(), event = {}) {
  await ensureIperfJobTables(db);
  const local = new Date(now + BEIJING_OFFSET);
  const date = local.toISOString().slice(0, 10);
  const time = local.toISOString().slice(11, 16);
  // 诊断记录保留实际筛选使用的同一份快照，不改变当前分钟匹配规则。
  const snapshot = (await db.prepare(`SELECT s.*,t.last_seen AS target_last_seen FROM iperf_schedules s
    JOIN servers v ON v.id=s.server_id LEFT JOIN iperf_targets t ON t.server_id=s.server_id
    WHERE s.enabled=1`).all()).results || [];
  const schedules = snapshot.filter(s => [s.time_beijing,s.time_beijing_day,s.time_beijing_extra].includes(time)
    && s.target_last_seen > now - 5 * 60_000);
  await db.prepare(`CREATE TABLE IF NOT EXISTS iperf_dispatch_audit (
    id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, scheduled_at INTEGER, cron TEXT,
    matched_minute TEXT NOT NULL, snapshot TEXT NOT NULL, enqueued INTEGER NOT NULL DEFAULT 0, error TEXT
  )`).run();
  const auditId = crypto.randomUUID();
  await db.prepare(`INSERT INTO iperf_dispatch_audit (id,observed_at,scheduled_at,cron,matched_minute,snapshot)
    VALUES (?,?,?,?,?,?)`).bind(auditId,now,event.scheduledTime ?? null,event.cron || '',`${date}T${time}+08:00`,
      JSON.stringify(snapshot.map(s => ({server_id:s.server_id,updated_at:s.updated_at,times:[s.time_beijing_day,s.time_beijing,s.time_beijing_extra],target_last_seen:s.target_last_seen,
        due:[s.time_beijing,s.time_beijing_day,s.time_beijing_extra].includes(time),ready:s.target_last_seen > now-5*60_000})))).run();
  const correlationId = event.correlationId || auditId;
  await iperfAudit(db, 'dispatch_selected', { audit_id: auditId, matched_minute: `${date}T${time}+08:00`,
    scheduled_at: event.scheduledTime ?? null, selection: snapshot.map(s => ({
      server_id: s.server_id, target_last_seen: s.target_last_seen ?? null,
      reason: ![s.time_beijing,s.time_beijing_day,s.time_beijing_extra].includes(time) ? 'time_not_due'
        : !(s.target_last_seen > now-5*60_000) ? 'target_not_ready' : 'eligible'
    })) }, correlationId);
  let enqueued = 0;
  try { for (const schedule of schedules) {
    const slot = `${date}T${time}+08:00`;
    const result = await db.prepare(`INSERT OR IGNORE INTO iperf_jobs
      (id,server_id,source,status,duration_seconds,scheduled_slot,created_at)
      VALUES (?,?,?,'queued',?,?,?)`).bind(crypto.randomUUID(), schedule.server_id,
      'scheduled', schedule.duration_seconds, slot, now).run();
    const inserted = result.meta?.changes || 0;
    enqueued += inserted;
    const blockers = inserted ? [] : (await db.prepare(`SELECT id,status,scheduled_slot FROM iperf_jobs
      WHERE server_id=? AND (scheduled_slot=? OR status IN ('queued','running'))`).bind(schedule.server_id,slot).all()).results || [];
    await iperfAudit(db, 'enqueue_result', { audit_id: auditId, server_id: schedule.server_id,
      slot, inserted, blockers }, correlationId);
  } } catch (error) {
    await db.prepare('UPDATE iperf_dispatch_audit SET error=? WHERE id=?').bind(String(error.message || error).slice(0,300),auditId).run();
    throw error;
  } finally {
    await db.prepare('UPDATE iperf_dispatch_audit SET enqueued=? WHERE id=?').bind(enqueued,auditId).run();
  }
  await db.prepare('DELETE FROM iperf_dispatch_audit WHERE observed_at<?').bind(now-7*86400_000).run();
}

function runnerAuthorized(request, env) {
  return !!env.IPERF_REPORT_TOKEN && request.headers.get('X-Iperf-Token') === env.IPERF_REPORT_TOKEN;
}

export async function handleIperfTargets(request, env) {
  if (!runnerAuthorized(request, env)) return createUnauthorizedResponse();
  let body;
  try { body = await request.json(); } catch { return createBadRequestResponse('invalidJson'); }
  let ids = body?.server_ids;
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !SERVER_ID.test(id))) {
    return createBadRequestResponse('invalidTargetIds');
  }
  await ensureIperfJobTables(env.DB);
  const deleted_ids = await deletedServerIds(env.DB, ids);
  ids = ids.filter(id => !deleted_ids.includes(id));
  for (const id of ids) if (!await serverExists(env.DB, id)) return createBadRequestResponse('unknownServer');
  const refreshId = await iperfAudit(env.DB, 'targets_refresh_begin', { server_ids: ids });
  // 自动助手可能已登记相同节点；在同一事务中刷新，避免主键冲突和清空窗口。
  const stale = ids.length
    ? env.DB.prepare(`DELETE FROM iperf_targets WHERE source='deb' AND server_id NOT IN (${ids.map(() => '?').join(',')})`).bind(...ids)
    : env.DB.prepare("DELETE FROM iperf_targets WHERE source='deb'");
  await env.DB.batch([stale, ...ids.map(id => env.DB.prepare(`INSERT INTO iperf_targets (server_id,source,last_seen)
    SELECT ?,'deb',? WHERE EXISTS (SELECT 1 FROM servers WHERE id=?) ON CONFLICT(server_id) DO UPDATE SET source='deb',last_seen=excluded.last_seen`).bind(id,Date.now(),id))]);
  await iperfAudit(env.DB, 'targets_refresh_complete', { server_ids: ids }, refreshId);
  return createSuccessResponse({ count: ids.length, deleted_ids });
}

export async function handleIperfClaim(request, env) {
  if (!runnerAuthorized(request, env)) return createUnauthorizedResponse();
  await ensureIperfJobTables(env.DB);
  const now = Date.now();
  await env.DB.prepare("UPDATE iperf_jobs SET status='failed',finished_at=?,error='runner lease expired' WHERE status='running' AND started_at<?")
    .bind(now, now - 20 * 60_000).run();
  const body=await request.json().catch(()=>({}));
  const requestId=body?.request_id;
  if(requestId!==undefined&&!/^[a-f0-9-]{36}$/.test(requestId))return createBadRequestResponse('invalidClaimRequest');
  let job;
  if(requestId) {
    if(body.recover_job_id) {
      await ensureIperfResultsTable(env.DB);
      await ensureAutoTables(env.DB);
      if(!/^[a-f0-9-]{36}$/.test(body.recover_job_id))return createBadRequestResponse('invalidRecovery');
      // 仅恢复无任何结果、无监听会话且没有新领取凭据的旧任务；不重测已有结果。
      await env.DB.prepare(`INSERT OR IGNORE INTO iperf_claim_requests
        SELECT ?,j.id,j.server_id,? FROM iperf_jobs j
        WHERE j.id=? AND (j.status='running' OR (j.status='failed' AND j.error='runner lease expired'))
        AND j.started_at<? AND NOT EXISTS(SELECT 1 FROM iperf_results r WHERE r.server_id=j.server_id AND r.tested_at>=j.started_at AND r.tested_at<=COALESCE(j.finished_at,?))
        AND NOT EXISTS(SELECT 1 FROM iperf_listeners l WHERE l.job_id=j.id)
        AND EXISTS(SELECT 1 FROM servers v WHERE v.id=j.server_id)
        AND NOT EXISTS(SELECT 1 FROM iperf_jobs other WHERE other.server_id=j.server_id AND other.id!=j.id AND other.status IN ('queued','running'))`)
        .bind(requestId,now,body.recover_job_id,now-60000,now).run();
      await env.DB.prepare(`UPDATE iperf_jobs SET status='queued',error=NULL,finished_at=NULL WHERE id=(SELECT job_id FROM iperf_claim_requests WHERE request_id=?) AND status='failed' AND error='runner lease expired'`).bind(requestId).run();
    } else {
      await env.DB.prepare(`INSERT OR IGNORE INTO iperf_claim_requests
        SELECT ?,id,server_id,? FROM iperf_jobs WHERE status='queued'
        AND NOT EXISTS(SELECT 1 FROM iperf_claim_requests c WHERE c.job_id=iperf_jobs.id)
        AND NOT EXISTS(SELECT 1 FROM iperf_claim_requests WHERE request_id=?) ORDER BY created_at,id LIMIT 1`)
        .bind(requestId,now,requestId).run();
    }
    await env.DB.prepare(`UPDATE iperf_jobs SET status='running',started_at=? WHERE status='queued'
      AND id=(SELECT job_id FROM iperf_claim_requests WHERE request_id=?)`).bind(now,requestId).run();
    job=await env.DB.prepare(`SELECT j.id,j.server_id,j.duration_seconds,j.source,j.status FROM iperf_jobs j JOIN iperf_claim_requests c ON c.job_id=j.id WHERE c.request_id=?`).bind(requestId).first();
    if(!job) {await iperfAudit(env.DB,'claim_empty');return createSuccessResponse(null);}
  } else {
    const candidate=await env.DB.prepare("SELECT id FROM iperf_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").first();
    if(!candidate){await iperfAudit(env.DB,'claim_empty');return createSuccessResponse(null);}
    const claimed=await env.DB.prepare("UPDATE iperf_jobs SET status='running',started_at=? WHERE id=? AND status='queued'").bind(now,candidate.id).run();
    if(!claimed.meta?.changes)return createSuccessResponse(null);
    job=await env.DB.prepare('SELECT id,server_id,duration_seconds,source,status FROM iperf_jobs WHERE id=?').bind(candidate.id).first();
  }
  await iperfAudit(env.DB, 'job_claimed', { job_id: job.id, server_id: job.server_id, source: job.source });
  job.auto_target = await getIperfAutoTarget(env.DB, job.server_id);
  return createSuccessResponse(job);
}

export async function handleIperfFinish(request, env) {
  if (!runnerAuthorized(request, env)) return createUnauthorizedResponse();
  let body;
  try { body = await request.json(); } catch { return createBadRequestResponse('invalidJson'); }
  if (!body || typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id) ||
      !['completed', 'failed'].includes(body.status) ||
      !Number.isInteger(body.result_count) || body.result_count < 0 || body.result_count > 4) return createBadRequestResponse('invalidIperfCompletion');
  await ensureIperfJobTables(env.DB);
  const job = await env.DB.prepare('SELECT * FROM iperf_jobs WHERE id=?').bind(body.id).first();
  if(!job)return createSuccessResponse({success:true,discarded:true,reason:'jobDeleted'});
  if(job.status===body.status && job.result_count===body.result_count && (job.error||null)===(body.error||null)) {
    await finishIperfAutoCheck(env.DB,job,body.status,body.error);
    return createSuccessResponse({success:true,already_applied:true});
  }
  const late=job?.status==='failed'&&job.error==='runner lease expired'&&body.status==='completed'&&body.cleanup_confirmed===true;
  if(late) {
    const rows=(await getIperfJobResults(env.DB)).get(body.id)||[];
    if(body.result_count<1||rows.length!==body.result_count)return createBadRequestResponse('completionEvidenceMismatch');
  }
  const result = await env.DB.prepare(`UPDATE iperf_jobs SET status=?,finished_at=?,error=?,result_count=? WHERE id=? AND (status='running' OR (?=1 AND status='failed' AND error='runner lease expired'))`)
    .bind(body.status, Date.now(), typeof body.error === 'string' ? body.error.slice(0, 200) : null,
      body.result_count, body.id,late?1:0).run();
  await iperfAudit(env.DB, 'job_finish', { job_id: body.id, server_id: job?.server_id ?? null, status: body.status, result_count: body.result_count, applied: result.meta?.changes || 0, error: typeof body.error === 'string' ? body.error.slice(0,200) : null });
  if (!result.meta?.changes) return createBadRequestResponse('iperfJobNotRunning');
  await finishIperfAutoCheck(env.DB, job, body.status, typeof body.error === 'string' ? body.error.slice(0, 200) : null);
  return createSuccessResponse({ success: true });
}
