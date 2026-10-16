import { checkAuth } from '../middleware/auth.js';
import { createBadRequestResponse, createSuccessResponse, createUnauthorizedResponse } from '../utils/errors.js';

const FAMILIES = new Set(['ipv4', 'ipv6']);
const DIRECTIONS = new Set(['upload', 'download']);
const STATUSES = new Set(['ok', 'no_response', 'failed']);

export async function ensureIperfResultsTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS iperf_results (
    run_id TEXT NOT NULL, server_id TEXT NOT NULL, source TEXT NOT NULL,
    family TEXT NOT NULL, direction TEXT NOT NULL, tested_at INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL, port INTEGER NOT NULL,
    status TEXT NOT NULL, mbps REAL, retransmits INTEGER, error TEXT,
    PRIMARY KEY (run_id, server_id, family, direction)
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_iperf_server_time ON iperf_results(server_id, tested_at DESC)').run();
}

export async function getIperfJobResults(db) {
  await ensureIperfResultsTable(db);
  // 旧任务没有 run_id 外键：仅在同节点、同测试时长、实际执行窗口内唯一批次时关联。
  // 不借用该节点的“最近一次”结果，失败清理任务也保留已完成的测速方向。
  const rows = (await db.prepare(`SELECT j.id AS job_id,r.* FROM
    (SELECT * FROM iperf_jobs ORDER BY created_at DESC LIMIT 100) j
    JOIN iperf_results r ON r.server_id=j.server_id AND r.source='deb'
      AND r.duration_seconds=j.duration_seconds
      AND r.tested_at>=j.started_at AND r.tested_at<=COALESCE(j.finished_at,?)
    WHERE j.source!='onboarding' AND j.started_at IS NOT NULL
      AND (j.finished_at IS NOT NULL OR j.status='running')
    ORDER BY r.tested_at,r.family,r.direction`).bind(Date.now()).all()).results || [];
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.job_id)) groups.set(row.job_id, []);
    groups.get(row.job_id).push(row);
  }
  for (const [id, results] of groups) {
    if (new Set(results.map(row => row.run_id)).size !== 1) groups.set(id, []);
  }
  return groups;
}

export function validateIperfResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { run_id, server_id, source, family, direction, status } = value;
  const tested_at = Number(value.tested_at);
  const duration_seconds = Number(value.duration_seconds);
  const port = Number(value.port);
  const mbps = value.mbps == null ? null : Number(value.mbps);
  const retransmits = value.retransmits == null ? null : Number(value.retransmits);
  if (![run_id, server_id, source].every(x => typeof x === 'string' && /^[a-zA-Z0-9._:-]{1,100}$/.test(x))) return null;
  if (!FAMILIES.has(family) || !DIRECTIONS.has(direction) || !STATUSES.has(status)) return null;
  if (!Number.isSafeInteger(tested_at) || Math.abs(Date.now() - tested_at) > 7 * 86400_000) return null;
  if (!Number.isInteger(duration_seconds) || duration_seconds < 1 || duration_seconds > 120) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (status === 'ok' && (!Number.isFinite(mbps) || mbps < 0 || !Number.isInteger(retransmits) || retransmits < 0)) return null;
  if (status !== 'ok' && (mbps !== null || retransmits !== null)) return null;
  const error = typeof value.error === 'string' ? value.error.slice(0, 200) : null;
  return { run_id, server_id, source, family, direction, tested_at, duration_seconds, port, status, mbps, retransmits, error };
}

export async function handleIperfReport(request, env) {
  const secret = env.IPERF_REPORT_TOKEN;
  if (!secret || request.headers.get('X-Iperf-Token') !== secret) return createUnauthorizedResponse();
  let body;
  try { body = await request.json(); } catch { return createBadRequestResponse('invalidJson'); }
  const rows = Array.isArray(body?.results) ? body.results : [body];
  if (rows.length < 1 || rows.length > 8) return createBadRequestResponse('invalidBatchSize');
  const results = rows.map(validateIperfResult);
  if (results.some(x => !x)) return createBadRequestResponse('invalidIperfResult');
  await ensureIperfResultsTable(env.DB);
  for (const row of results) {
    const exists = await env.DB.prepare('SELECT id FROM servers WHERE id = ?').bind(row.server_id).first();
    if (!exists) return createBadRequestResponse('unknownServer');
  }
  const sql = `INSERT INTO iperf_results (run_id, server_id, source, family, direction, tested_at, duration_seconds, port, status, mbps, retransmits, error)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM servers WHERE id=?)
    ON CONFLICT(run_id, server_id, family, direction) DO UPDATE SET status=excluded.status, mbps=excluded.mbps, retransmits=excluded.retransmits, error=excluded.error`;
  await env.DB.batch(results.map(r => env.DB.prepare(sql).bind(...[
    r.run_id, r.server_id, r.source, r.family, r.direction, r.tested_at,
    r.duration_seconds, r.port, r.status, r.mbps, r.retransmits, r.error, r.server_id
  ])));
  return createSuccessResponse({ success: true, count: results.length });
}

export async function handleIperfResults(request, env, sys) {
  if (sys.is_public !== 'true' && !await checkAuth(request, env, sys)) return createUnauthorizedResponse();
  const url = new URL(request.url);
  const serverId = url.searchParams.get('id');
  if (!serverId || !/^[a-zA-Z0-9._:-]{1,100}$/.test(serverId)) return createBadRequestResponse('invalidServerId');
  await ensureIperfResultsTable(env.DB);
  if (url.searchParams.get('view') === 'history') {
    const requestedPage = Number(url.searchParams.get('page') || 1);
    const pageSize = Number(url.searchParams.get('page_size') || 5);
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || ![5, 10, 20].includes(pageSize)) {
      return createBadRequestResponse('invalidPagination');
    }
    const total = await env.DB.prepare('SELECT COUNT(DISTINCT run_id) AS total FROM iperf_results WHERE server_id = ?').bind(serverId).first();
    const totalRuns = Number(total?.total || 0);
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(totalRuns / pageSize)));
    // 按完整测试批次分页，避免把同一次测试的四个方向拆到两页。
    const rows = await env.DB.prepare(`SELECT * FROM iperf_results WHERE server_id = ? AND run_id IN (
      SELECT run_id FROM iperf_results WHERE server_id = ? GROUP BY run_id
      ORDER BY MAX(tested_at) DESC, run_id DESC LIMIT ? OFFSET ?
    ) ORDER BY tested_at DESC, run_id DESC`).bind(serverId, serverId, pageSize, (page - 1) * pageSize).all();
    return createSuccessResponse({ rows: rows.results || [], page, page_size: pageSize, total_runs: totalRuns });
  }
  const rows = await env.DB.prepare('SELECT * FROM iperf_results WHERE server_id = ? ORDER BY tested_at DESC LIMIT 80').bind(serverId).all();
  return createSuccessResponse(rows.results || []);
}
