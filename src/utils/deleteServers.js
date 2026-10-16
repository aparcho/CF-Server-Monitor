import { AppError } from './errors.js';

export async function ensureDeletedServers(db) {
  // 仅保留删除标识，供采集器明确区分“已删除”和“暂时请求失败”。
  await db.prepare(`CREATE TABLE IF NOT EXISTS deleted_servers (
    id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL CHECK(deleted_at>0)
  )`).run();
}

export async function deletedServerIds(db, ids) {
  await ensureDeletedServers(db);
  if (!ids.length) return [];
  return (await db.prepare(`SELECT id FROM deleted_servers WHERE id IN (${ids.map(()=>'?').join(',')}) AND NOT EXISTS (SELECT 1 FROM servers WHERE servers.id=deleted_servers.id)`)
    .bind(...ids).all()).results.map(r=>r.id);
}

export async function deleteServers(db, ids) {
  ids=[...new Set(ids)];
  await ensureDeletedServers(db);
  const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results;
  const names=new Set(tables.map(t=>t.name));
  const owned=[];
  for(const {name} of tables) {
    if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))continue;
    const columns=(await db.prepare(`PRAGMA table_info("${name}")`).all()).results;
    if(columns.some(c=>c.name==='server_id'))owned.push(name);
  }
  const statements=[];
  for(const id of ids) {
    // CHECK 约束使整个 batch 回滚；测速尚在运行时保留其清理所需的登记与会话。
    statements.push(db.prepare(`INSERT INTO deleted_servers(id,deleted_at) VALUES (?,
      CASE WHEN ${names.has('iperf_jobs') ? "EXISTS(SELECT 1 FROM iperf_jobs WHERE server_id=? AND status='running')" : '0'}
      THEN 0 ELSE ? END) ON CONFLICT(id) DO UPDATE SET deleted_at=excluded.deleted_at`)
      .bind(...(names.has('iperf_jobs')?[id,id,Date.now()]:[id,Date.now()])));
    for(const table of owned)statements.push(db.prepare(`DELETE FROM "${table}" WHERE server_id=?`).bind(id));
    statements.push(db.prepare('DELETE FROM servers WHERE id=?').bind(id));
  }
  try { await db.batch(statements); }
  catch(error) {
    if(/CHECK constraint failed.*deleted_at/i.test(error.message||''))
      throw new AppError('节点测速仍在运行，请等待测速及临时端口清理完成后再删除',409);
    throw error;
  }
}
