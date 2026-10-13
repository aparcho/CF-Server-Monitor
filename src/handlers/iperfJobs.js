import { createBadRequestResponse, createSuccessResponse, createUnauthorizedResponse } from '../utils/errors.js';

const SERVER_ID = /^[a-zA-Z0-9._:-]{1,100}$/;
const BEIJING_OFFSET = 8 * 3600_000;

export async function ensureIperfJobTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS iperf_jobs (
    id TEXT PRIMARY KEY, server_id TEXT NOT NULL, source TEXT NOT NULL,
    status TEXT NOT NULL, duration_seconds INTEGER NOT NULL, scheduled_slot TEXT,
    created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
    error TEXT, result_count INTEGER
  )`).run();
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_iperf_job_slot ON iperf_jobs(server_id, scheduled_slot) WHERE scheduled_slot IS NOT NULL').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_iperf_job_status ON iperf_jobs(status, created_at)').run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_iperf_one_active ON iperf_jobs(server_id) WHERE status IN ('queued','running')").run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS iperf_schedules (
    server_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
    time_beijing TEXT NOT NULL DEFAULT '03:00', duration_seconds INTEGER NOT NULL DEFAULT 10,
    updated_at INTEGER NOT NULL
  )`).run();
}

function validDuration(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 5 && n <= 30 ? n : null;
}

async function serverExists(db, id) {
  return !!await db.prepare('SELECT id FROM servers WHERE id = ?').bind(id).first();
}

export async function handleIperfAdminAction(data, env) {
  await ensureIperfJobTables(env.DB);
  const { action } = data;
  if (action === 'iperf_list') {
    const [jobs, schedules] = await Promise.all([
      env.DB.prepare('SELECT * FROM iperf_jobs ORDER BY created_at DESC LIMIT 100').all(),
      env.DB.prepare('SELECT * FROM iperf_schedules ORDER BY server_id').all()
    ]);
    return createSuccessResponse({ jobs: jobs.results || [], schedules: schedules.results || [] });
  }
  const id = data.server_id;
  if (typeof id !== 'string' || !SERVER_ID.test(id) || !await serverExists(env.DB, id)) return createBadRequestResponse('unknownServer');
  const duration = validDuration(data.duration_seconds);
  if (!duration) return createBadRequestResponse('invalidDuration');
  if (action === 'iperf_trigger') {
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
    if (enabled === null || typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return createBadRequestResponse('invalidIperfSchedule');
    await env.DB.prepare(`INSERT INTO iperf_schedules (server_id,enabled,time_beijing,duration_seconds,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET enabled=excluded.enabled,
      time_beijing=excluded.time_beijing,duration_seconds=excluded.duration_seconds,updated_at=excluded.updated_at`)
      .bind(id, enabled, time, duration, Date.now()).run();
    return createSuccessResponse({ server_id: id, enabled, time_beijing: time, duration_seconds: duration });
  }
  return createBadRequestResponse('unknownIperfAction');
}

export async function enqueueDueIperfJobs(db, now = Date.now()) {
  await ensureIperfJobTables(db);
  const local = new Date(now + BEIJING_OFFSET);
  const date = local.toISOString().slice(0, 10);
  const time = local.toISOString().slice(11, 16);
  const schedules = await db.prepare(`SELECT s.* FROM iperf_schedules s JOIN servers v ON v.id=s.server_id
    WHERE s.enabled=1 AND s.time_beijing=?`).bind(time).all();
  for (const schedule of schedules.results || []) {
    const slot = `${date}T${time}+08:00`;
    await db.prepare(`INSERT OR IGNORE INTO iperf_jobs
      (id,server_id,source,status,duration_seconds,scheduled_slot,created_at)
      VALUES (?,?,?,'queued',?,?,?)`).bind(crypto.randomUUID(), schedule.server_id,
      'scheduled', schedule.duration_seconds, slot, now).run();
  }
}

function runnerAuthorized(request, env) {
  return !!env.IPERF_REPORT_TOKEN && request.headers.get('X-Iperf-Token') === env.IPERF_REPORT_TOKEN;
}

export async function handleIperfClaim(request, env) {
  if (!runnerAuthorized(request, env)) return createUnauthorizedResponse();
  await ensureIperfJobTables(env.DB);
  const now = Date.now();
  await env.DB.prepare("UPDATE iperf_jobs SET status='failed',finished_at=?,error='runner lease expired' WHERE status='running' AND started_at<?")
    .bind(now, now - 20 * 60_000).run();
  const candidate = await env.DB.prepare("SELECT id FROM iperf_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").first();
  if (!candidate) return createSuccessResponse(null);
  const claimed = await env.DB.prepare("UPDATE iperf_jobs SET status='running',started_at=? WHERE id=? AND status='queued'")
    .bind(now, candidate.id).run();
  if (!claimed.meta?.changes) return createSuccessResponse(null);
  const job = await env.DB.prepare('SELECT id,server_id,duration_seconds FROM iperf_jobs WHERE id=?').bind(candidate.id).first();
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
  const result = await env.DB.prepare("UPDATE iperf_jobs SET status=?,finished_at=?,error=?,result_count=? WHERE id=? AND status='running'")
    .bind(body.status, Date.now(), typeof body.error === 'string' ? body.error.slice(0, 200) : null,
      body.result_count, body.id).run();
  if (!result.meta?.changes) return createBadRequestResponse('iperfJobNotRunning');
  return createSuccessResponse({ success: true });
}
