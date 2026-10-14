import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueDueIperfJobs, ensureIperfJobTables, handleIperfAdminAction } from '../src/handlers/iperfJobs.js';

const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE servers (id TEXT PRIMARY KEY)');
  return { sqlite, DB: { prepare(sql) {
    let params = [];
    return {
      bind(...values) { params = values; return this; },
      async run() { const result = sqlite.prepare(sql).run(...params); return { meta: { changes: result.changes } }; },
      async first() { return sqlite.prepare(sql).get(...params) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...params) }; },
    };
  } } };
}

test('旧单时段配置升级后保留晚高峰和启用状态，新增 11:30', { skip: !DatabaseSync }, async () => {
  const { DB, sqlite } = database();
  try {
    sqlite.exec(`CREATE TABLE iperf_schedules (server_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL,
      time_beijing TEXT NOT NULL, duration_seconds INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO iperf_schedules VALUES ('oci',1,'22:00',10,1),('sg',0,'03:00',30,1)`);
    await ensureIperfJobTables(DB);
    await ensureIperfJobTables(DB);
    const rows = sqlite.prepare('SELECT * FROM iperf_schedules ORDER BY server_id').all();
    assert.equal(rows[0].time_beijing, '22:00');
    assert.equal(rows[0].time_beijing_day, '11:30');
    assert.equal(rows[0].enabled, 1);
    assert.equal(rows[1].enabled, 0);
    assert.equal(rows[1].time_beijing, '03:00');
  } finally { sqlite.close(); }
});

test('同一天两次定时各入队一次，重复 cron 去重，关闭与未就绪节点不排队', { skip: !DatabaseSync }, async () => {
  const { DB, sqlite } = database();
  try {
    await ensureIperfJobTables(DB);
    const morning = Date.parse('2026-10-15T03:30:00Z');
    const evening = Date.parse('2026-10-15T14:00:00Z');
    sqlite.exec("INSERT INTO servers VALUES ('oci'),('sg'),('unready')");
    const insert = sqlite.prepare('INSERT INTO iperf_schedules (server_id,enabled,time_beijing,time_beijing_day,duration_seconds,updated_at) VALUES (?,?,?,?,?,?)');
    insert.run('oci', 1, '22:00', '11:30', 10, morning);
    insert.run('sg', 0, '22:00', '11:30', 10, morning);
    insert.run('unready', 1, '22:00', '11:30', 10, morning);
    const ready = sqlite.prepare('INSERT OR REPLACE INTO iperf_targets VALUES (?,?,?)');
    ready.run('oci', 'deb', morning);
    ready.run('sg', 'deb', morning);
    ready.run('unready', 'deb', morning - 600_000);
    await enqueueDueIperfJobs(DB, morning);
    await enqueueDueIperfJobs(DB, morning + 30_000);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM iperf_jobs').get().n, 1);
    sqlite.exec("UPDATE iperf_jobs SET status='completed'");
    ready.run('oci', 'deb', evening);
    await enqueueDueIperfJobs(DB, evening);
    await enqueueDueIperfJobs(DB, evening + 30_000);
    const jobs = sqlite.prepare('SELECT server_id, scheduled_slot FROM iperf_jobs ORDER BY created_at').all();
    assert.deepEqual(jobs.map(row => [row.server_id, row.scheduled_slot]), [
      ['oci', '2026-10-15T11:30+08:00'], ['oci', '2026-10-15T22:00+08:00'],
    ]);
  } finally { sqlite.close(); }
});

test('保存两个不同时间，旧客户端省略日间时间时保留已设置值', { skip: !DatabaseSync }, async () => {
  const { DB, sqlite } = database();
  try {
    await ensureIperfJobTables(DB);
    sqlite.exec("INSERT INTO servers VALUES ('oci')");
    sqlite.prepare('INSERT INTO iperf_targets VALUES (?,?,?)').run('oci', 'deb', Date.now());
    const action = { action: 'iperf_schedule', server_id: 'oci', enabled: true, time_beijing: '22:00', time_beijing_day: '11:45', duration_seconds: 10 };
    assert.equal((await handleIperfAdminAction(action, { DB })).status, 200);
    assert.equal((await handleIperfAdminAction({ ...action, time_beijing_day: '22:00' }, { DB })).status, 400);
    assert.equal((await handleIperfAdminAction({ ...action, time_beijing_day: '25:00' }, { DB })).status, 400);
    const { time_beijing_day, ...legacy } = action;
    const saved = await (await handleIperfAdminAction({ ...legacy, time_beijing: '21:40' }, { DB })).json();
    assert.equal(saved.time_beijing_day, '11:45');
    assert.equal(saved.time_beijing, '21:40');
  } finally { sqlite.close(); }
});

test('三次5秒：迁移不新增默认时段，第三次去重，旧客户端保留第三次，可清除', { skip: !DatabaseSync }, async () => {
  const { DB, sqlite } = database();
  try {
    await ensureIperfJobTables(DB);
    sqlite.exec("INSERT INTO servers VALUES ('oci')");
    const target = sqlite.prepare('INSERT OR REPLACE INTO iperf_targets VALUES (?,?,?)');
    target.run('oci','deb',Date.now());
    const action={action:'iperf_schedule',server_id:'oci',enabled:true,time_beijing_day:'11:30',time_beijing:'22:00',time_beijing_extra:'21:00',duration_seconds:5};
    assert.equal((await handleIperfAdminAction(action,{DB})).status,200);
    assert.equal((await handleIperfAdminAction({...action,time_beijing_extra:'22:00'},{DB})).status,400);
    assert.equal((await handleIperfAdminAction({...action,time_beijing_extra:'25:00'},{DB})).status,400);
    const {time_beijing_extra,...legacy}=action;
    assert.equal((await (await handleIperfAdminAction(legacy,{DB})).json()).time_beijing_extra,'21:00');
    for(const hour of ['11:30','21:00','22:00']) {
      const now=Date.parse(`2026-10-15T${hour}:00+08:00`);
      target.run('oci','deb',now);
      await enqueueDueIperfJobs(DB,now);
      await enqueueDueIperfJobs(DB,now+30000);
      sqlite.exec("UPDATE iperf_jobs SET status='completed'");
    }
    const jobs=sqlite.prepare('SELECT duration_seconds,scheduled_slot FROM iperf_jobs ORDER BY created_at').all();
    assert.equal(jobs.length,3);
    assert.ok(jobs.every(r=>r.duration_seconds===5));
    target.run('oci','deb',Date.now());
    assert.equal((await (await handleIperfAdminAction({...action,time_beijing_extra:''},{DB})).json()).time_beijing_extra,null);
  } finally {sqlite.close();}
});
