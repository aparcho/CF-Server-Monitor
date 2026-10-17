import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueDueIperfJobs, enqueueExpiredIperfJobs, ensureIperfJobTables, handleIperfAdminAction, refreshPolicy } from '../src/handlers/iperfJobs.js';
import { ensureIperfResultsTable } from '../src/handlers/iperf.js';

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
    assert.ok(rows.every(row=>row.expiry_refresh_enabled===0));
  } finally { sqlite.close(); }
});

test('到期补测独立开关保留每日计划，12小时边界、手动刷新、重复派发及失败冷却', {skip:!DatabaseSync}, async()=>{
  const {DB,sqlite}=database();
  try {
    await ensureIperfJobTables(DB);await ensureIperfResultsTable(DB);
    const now=Date.parse('2026-10-17T04:00:00Z'),hour=3600000;
    sqlite.exec("INSERT INTO servers VALUES ('lax'),('off'),('new'),('gone');");
    const schedule=sqlite.prepare("INSERT INTO iperf_schedules(server_id,enabled,time_beijing,duration_seconds,updated_at,expiry_refresh_enabled) VALUES (?,0,'03:00',10,?,?)");
    for(const [id,enabled] of [['lax',1],['off',0],['new',1],['gone',1]])schedule.run(id,now,enabled);
    const target=sqlite.prepare('INSERT OR REPLACE INTO iperf_targets VALUES (?,?,?)');
    for(const id of ['lax','off','new','gone'])target.run(id,'deb',now);
    const result=sqlite.prepare(`INSERT OR REPLACE INTO iperf_results VALUES (? ,?,'deb',?,'download',?,10,5202,'ok',100,0,NULL)`);
    result.run('old','lax','ipv4',now-12*hour);result.run('old','lax','ipv6',now-11*hour);
    result.run('old','off','ipv4',now-80*hour);result.run('old','gone','ipv4',now-80*hour);
    sqlite.exec("DELETE FROM servers WHERE id='gone'");
    assert.equal(await enqueueExpiredIperfJobs(DB,now),0);
    assert.equal(await enqueueExpiredIperfJobs(DB,now+1),1);
    assert.equal(await enqueueExpiredIperfJobs(DB,now+2),0);
    const job=sqlite.prepare("SELECT * FROM iperf_jobs WHERE source='refresh'").get();
    assert.equal(job.server_id,'lax');assert.equal(job.duration_seconds,5);
    sqlite.exec("UPDATE iperf_jobs SET status='failed'");
    target.run('lax','deb',now+5*hour);
    assert.equal(await enqueueExpiredIperfJobs(DB,now+5*hour),0);
    target.run('lax','deb',now+7*hour);
    result.run('manual','lax','ipv4',now+6*hour);result.run('manual','lax','ipv6',now+6*hour);
    assert.equal(await enqueueExpiredIperfJobs(DB,now+7*hour),0);
    sqlite.exec("DELETE FROM iperf_results WHERE run_id='manual'");
    // 失败也占用滚动24小时内唯一一次额度，冷却结束后仍不能再测。
    assert.equal(await enqueueExpiredIperfJobs(DB,now+7*hour),0);
    target.run('lax','deb',Date.now());
    const disabled=await handleIperfAdminAction({action:'iperf_expiry_refresh',server_id:'lax',enabled:false},{DB});
    assert.equal(disabled.status,200);
    const saved=sqlite.prepare("SELECT * FROM iperf_schedules WHERE server_id='lax'").get();
    assert.equal(saved.expiry_refresh_enabled,0);assert.equal(saved.enabled,0);assert.equal(saved.time_beijing,'03:00');assert.equal(saved.duration_seconds,10);
    assert.equal((await handleIperfAdminAction({action:'iperf_expiry_refresh',server_id:'lax',enabled:'true'},{DB})).status,400);
  } finally {sqlite.close();}
});

test('到期补测遇到正在运行的手工测速或未就绪目标不排队', {skip:!DatabaseSync}, async()=>{
  const {DB,sqlite}=database();
  try {
    await ensureIperfJobTables(DB);await ensureIperfResultsTable(DB);
    const now=Date.now();sqlite.exec("INSERT INTO servers VALUES ('busy'),('unready');");
    for(const id of ['busy','unready']) {
      sqlite.prepare('INSERT INTO iperf_schedules(server_id,duration_seconds,updated_at,expiry_refresh_enabled) VALUES (?,5,?,1)').run(id,now);
      sqlite.prepare("INSERT INTO iperf_results VALUES ('old',?,'deb','ipv4','download',?,5,5202,'ok',100,0,NULL)").run(id,now-80*3600000);
    }
    sqlite.prepare("INSERT INTO iperf_targets VALUES ('busy','deb',?)").run(now);
    sqlite.prepare("INSERT INTO iperf_jobs(id,server_id,source,status,duration_seconds,created_at) VALUES ('manual','busy','manual','running',5,?)").run(now);
    assert.equal(await enqueueExpiredIperfJobs(DB,now),0);
    const audit=sqlite.prepare("SELECT detail FROM iperf_event_audit WHERE phase='expiry_refresh_skipped' AND json_extract(detail,'$.server_id')='unready'").get();
    assert.equal(JSON.parse(audit.detail).reason,'target_not_ready');
  }finally {sqlite.close();}
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

test('诊断记录区分时间未到、未就绪、已有任务冲突并关联派发', { skip: !DatabaseSync }, async () => {
  const { DB, sqlite } = database();
  try {
    await ensureIperfJobTables(DB);
    const now = Date.parse('2026-10-15T14:00:00Z');
    sqlite.exec("INSERT INTO servers VALUES ('busy'),('unready'),('later')");
    const save = sqlite.prepare('INSERT INTO iperf_schedules (server_id,enabled,time_beijing,duration_seconds,updated_at) VALUES (?,1,?,5,?)');
    for (const [id,time] of [['busy','22:00'],['unready','22:00'],['later','23:00']]) save.run(id,time,now);
    sqlite.prepare('INSERT INTO iperf_targets VALUES (?,?,?)').run('busy','deb',now);
    sqlite.prepare("INSERT INTO iperf_jobs (id,server_id,source,status,duration_seconds,created_at) VALUES ('old','busy','manual','running',5,?)").run(now);
    await enqueueDueIperfJobs(DB, now, {correlationId:'cron-example',scheduledTime:now-2000});
    const rows = sqlite.prepare('SELECT * FROM iperf_event_audit ORDER BY rowid').all();
    const selection = JSON.parse(rows.find(r=>r.phase==='dispatch_selected').detail).selection;
    assert.deepEqual(selection.map(x=>[x.server_id,x.reason]).sort(), [
      ['busy','eligible'],['later','time_not_due'],['unready','target_not_ready']]);
    const result = JSON.parse(rows.find(r=>r.phase==='enqueue_result').detail);
    assert.equal(result.inserted,0);
    assert.equal(result.blockers[0].id,'old');
    assert.ok(rows.every(r=>r.correlation_id==='cron-example'));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM iperf_jobs').get().n,1);
  } finally { sqlite.close(); }
});

test('按需补测全天超过12小时才触发，滚动24小时最多1次', {skip:!DatabaseSync},async()=>{
 const {DB,sqlite}=database();
 try {
  await ensureIperfJobTables(DB);await ensureIperfResultsTable(DB);
  const now=Date.parse('2026-10-17T22:01:00+08:00'),hour=3600000;
  for(const offset of [0,-2,-12])assert.equal(refreshPolicy(now+offset*hour).age_ms,12*hour);
  assert.equal(refreshPolicy(now).limit,1);
  sqlite.exec("INSERT INTO servers VALUES ('lax');INSERT INTO iperf_schedules(server_id,updated_at,expiry_refresh_enabled) VALUES ('lax',0,1)");
  sqlite.prepare("INSERT INTO iperf_targets VALUES ('lax','deb',?)").run(now);
  sqlite.prepare("INSERT INTO iperf_results VALUES ('old','lax','deb','ipv4','download',?,5,5202,'ok',100,0,NULL)").run(now-2*hour);
  // 截图中的20点测速不会在22点再次触发，12小时边界也不触发。
  assert.equal(await enqueueExpiredIperfJobs(DB,now),0);
  sqlite.prepare('UPDATE iperf_results SET tested_at=?').run(now-12*hour);
  assert.equal(await enqueueExpiredIperfJobs(DB,now),0);
  sqlite.prepare('UPDATE iperf_results SET tested_at=?').run(now-13*hour);
  const job=sqlite.prepare("INSERT INTO iperf_jobs(id,server_id,source,status,duration_seconds,created_at) VALUES (?,'lax',?,'completed',5,?)");
  job.run('refresh','refresh',now-23*hour);
  assert.equal(await enqueueExpiredIperfJobs(DB,now),0);
  // 滚动24小时之外的尝试不占用今天名额；重复调度仍只入队一次。
  sqlite.prepare("UPDATE iperf_jobs SET created_at=? WHERE id='refresh'").run(now-24*hour-1);
  assert.equal(await enqueueExpiredIperfJobs(DB,now),1);
  assert.equal(await enqueueExpiredIperfJobs(DB,now),0);
 }finally{sqlite.close();}
});

test('手动与定时新结果重新计算12小时，关闭补测开关不排队', {skip:!DatabaseSync},async()=>{
 const {DB,sqlite}=database();
 try {
  await ensureIperfJobTables(DB);await ensureIperfResultsTable(DB);
  const now=Date.parse('2026-10-17T22:00:00+08:00'),hour=3600000;
  sqlite.exec("INSERT INTO servers VALUES ('lax');INSERT INTO iperf_schedules(server_id,updated_at,expiry_refresh_enabled) VALUES ('lax',0,1)");
  sqlite.prepare("INSERT INTO iperf_targets VALUES ('lax','deb',?)").run(now);
  sqlite.prepare("INSERT INTO iperf_results VALUES ('old','lax','deb','ipv4','download',?,5,5202,'ok',100,0,NULL)").run(now-20*hour);
  for(const source of ['manual','scheduled']){
   sqlite.prepare("INSERT OR REPLACE INTO iperf_jobs(id,server_id,source,status,duration_seconds,created_at) VALUES ('new','lax',?,'completed',5,?)").run(source,now-3*hour);
   sqlite.prepare("INSERT OR REPLACE INTO iperf_results VALUES ('new','lax','deb','ipv4','download',?,5,5202,'ok',100,0,NULL)").run(now-3*hour);
   assert.equal(await enqueueExpiredIperfJobs(DB,now),0);
  }
  sqlite.exec("DELETE FROM iperf_results WHERE run_id='new'; UPDATE iperf_schedules SET expiry_refresh_enabled=0");
  assert.equal(await enqueueExpiredIperfJobs(DB,now),0);
 }finally{sqlite.close();}
});
