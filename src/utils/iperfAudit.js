// 所有事件仍输出控制台；D1只抽样重复空轮询，关键派发、执行、错误完整保留。
export function shouldPersistIperfAudit(phase,detail={},now=Date.now()) {
  if(detail.error || Number(detail.status)>=400)return true;
  const routine=['claim_empty','targets_refresh_begin','targets_refresh_complete','expiry_refresh_checked'].includes(phase)
    || (phase==='expiry_refresh_skipped' && ['daily_limit','retry_cooldown'].includes(detail.reason))
    || (['request_enter','request_exit'].includes(phase) && ['/api/iperf/targets','/api/iperf/jobs/claim'].includes(detail.path));
  return !routine || Math.floor(now/60_000)%15===0;
}
// 与业务数据库故障相互独立的控制台日志；D1 副本便于按任务和时间核查。
export async function iperfAudit(db, phase, detail = {}, correlationId = crypto.randomUUID()) {
  const observedAt = Date.now();
  const entry = { scope: 'iperf', phase, correlation_id: correlationId, observed_at: observedAt, ...detail };
  const persist=shouldPersistIperfAudit(phase,detail,observedAt);
  console.log(JSON.stringify({...entry,d1_sampled:!persist}));
  if(!persist)return correlationId;
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS iperf_event_audit (
      id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, phase TEXT NOT NULL,
      correlation_id TEXT NOT NULL, detail TEXT NOT NULL
    )`).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_iperf_event_time ON iperf_event_audit(observed_at)').run();
    await db.prepare('INSERT INTO iperf_event_audit VALUES (?,?,?,?,?)')
      .bind(crypto.randomUUID(), observedAt, phase, correlationId, JSON.stringify(detail)).run();
  } catch (error) {
    console.error(JSON.stringify({ scope: 'iperf', phase: 'audit_write_failed', correlation_id: correlationId,
      observed_at: Date.now(), error: String(error.message || error).slice(0, 500) }));
  }
  return correlationId;
}

export async function traceIperfRequest(db, path, handler) {
  const id = await iperfAudit(db, 'request_enter', { path });
  try {
    const response = await handler();
    await iperfAudit(db, 'request_exit', { path, status: response.status }, id);
    return response;
  } catch (error) {
    await iperfAudit(db, 'request_error', { path, error: String(error.message || error).slice(0, 500) }, id);
    throw error;
  }
}
