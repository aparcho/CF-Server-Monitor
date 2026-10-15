// 与业务数据库故障相互独立的控制台日志；D1 副本便于按任务和时间核查。
export async function iperfAudit(db, phase, detail = {}, correlationId = crypto.randomUUID()) {
  const observedAt = Date.now();
  const entry = { scope: 'iperf', phase, correlation_id: correlationId, observed_at: observedAt, ...detail };
  console.log(JSON.stringify(entry));
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
