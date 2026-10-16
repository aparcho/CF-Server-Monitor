import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryId } from '../src/database/indexOptimization.js';
import { handleIperfBootstrap, handleIperfNode, handleIperfListener } from '../src/handlers/iperfAuto.js';
import { handleIperfClaim, handleIperfFinish, handleIperfAdminAction, handleIperfTargets } from '../src/handlers/iperfJobs.js';
const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec("CREATE TABLE servers (id TEXT PRIMARY KEY,history_partition_id INTEGER,timestamp INTEGER); INSERT INTO servers VALUES ('new',1,0),('other',2,0); CREATE TABLE metrics_history (id INTEGER PRIMARY KEY,ip_v4 TEXT,ip_v6 TEXT)");
  sqlite.prepare('INSERT INTO metrics_history VALUES (?,?,?)').run(buildHistoryId(1,Date.now()),'8.8.8.8','2001:4860:4860::8888');
  sqlite.prepare('INSERT INTO metrics_history VALUES (?,?,?)').run(buildHistoryId(2,Date.now()),'1.1.1.1',null);
  const DB = { prepare(sql) { let args = []; return {
    bind(...values) { args = values; return this; },
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { return { meta: { changes: sqlite.prepare(sql).run(...args).changes } }; },
  }; }, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const rows=[]; for(const statement of statements) rows.push(await statement.run()); sqlite.exec('COMMIT'); return rows; }
    catch(error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { sqlite, env: { DB, API_SECRET: 'monitor-test', IPERF_REPORT_TOKEN: 'runner-test' } };
}
const request = (path, data, headers = {}) => new Request('https://monitor.example' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
const runner = data => request('/runner', data, { 'X-Iperf-Token': 'runner-test' });

test('自动接入完整闭环：节点凭证隔离、检查去重、临时监听握手与默认关闭', { skip: !DatabaseSync }, async () => {
  const { sqlite, env } = setup();
  try {
    assert.equal((await handleIperfBootstrap(request('/bootstrap', { id: 'new', secret: 'wrong' }), env)).status, 401);
    const bootstrap = await (await handleIperfBootstrap(request('/bootstrap', { id: 'new', secret: 'monitor-test' }), env)).json();
    const headers = { 'X-Iperf-Node-Token': bootstrap.token };
    const node = data => handleIperfNode(request('/node', { id: 'new', ipv4: '8.8.8.8', ipv6: '2001:4860:4860::8888', ...data }, headers), env);
    await handleIperfBootstrap(request('/bootstrap', { id: 'other', secret: 'monitor-test' }), env);
    assert.equal((await handleIperfNode(request('/node', { id: 'other', ipv4: '1.1.1.1' }, headers), env)).status, 401);
    assert.equal((await node({ ipv4: '127.0.0.1' })).status, 400);
    await node({ ipv4: '9.9.9.9' });
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM iperf_jobs').get().n, 0);
    await node({}); await node({});
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM iperf_jobs').get().n, 1);
    const schedule = sqlite.prepare("SELECT * FROM iperf_schedules WHERE server_id='new'").get();
    assert.equal(schedule.enabled, 0);
    assert.equal(schedule.time_beijing_day, '11:30');
    assert.equal(schedule.time_beijing, '21:30');
    const job = await (await handleIperfClaim(runner({}), env)).json();
    assert.equal(job.source, 'onboarding');
    assert.equal(job.auto_target.transport, 'worker');
    assert.equal((await handleIperfListener(runner({ action: 'start', job_id: job.id, sources: ['nonsense'] }), env)).status, 400);
    await handleIperfListener(runner({ action: 'start', job_id: job.id, sources: ['1.1.1.1'] }), env);
    const command = await (await node({})).json();
    assert.equal(command.command, 'start');
    assert.deepEqual(command.sources, ['1.1.1.1']);
    await node({ session: { job_id: job.id, state: 'ready' } });
    assert.equal((await (await handleIperfListener(runner({ action: 'status', job_id: job.id }), env)).json()).state, 'ready');
    await handleIperfListener(runner({ action: 'stop', job_id: job.id }), env);
    assert.equal((await (await node({})).json()).command, 'stop');
    await node({ session: { job_id: job.id, state: 'stopped' } });
    const finished = await handleIperfFinish(runner({ id: job.id, status: 'completed', result_count: 0 }), env);
    assert.equal(finished.status, 200);
    assert.equal(sqlite.prepare("SELECT status FROM iperf_enrollments WHERE server_id='new'").get().status, 'ready');
    assert.equal(sqlite.prepare("SELECT enabled FROM iperf_schedules WHERE server_id='new'").get().enabled, 0);
    await handleIperfTargets(runner({ server_ids: [] }), env);
    assert.ok(sqlite.prepare("SELECT * FROM iperf_targets WHERE server_id='new'").get());
    assert.equal((await handleIperfAdminAction({ action: 'iperf_trigger', server_id: 'new', duration_seconds: 10 }, env)).status, 200);
    const manual = await (await handleIperfClaim(runner({}), env)).json();
    assert.equal(manual.auto_target.ipv4, '8.8.8.8');
  } finally { sqlite.close(); }
});

test('自动接入失败显示原因且不启用定时，重新安装保留已保存定时', { skip: !DatabaseSync }, async () => {
  const { sqlite, env } = setup();
  try {
    const boot = await (await handleIperfBootstrap(request('/bootstrap', { id: 'new', secret: 'monitor-test' }), env)).json();
    const node = data => handleIperfNode(request('/node', { id: 'new', ipv4: '8.8.8.8', ...data }, { 'X-Iperf-Node-Token': boot.token }), env);
    await node({});
    const job = await (await handleIperfClaim(runner({}), env)).json();
    await handleIperfFinish(runner({ id: job.id, status: 'failed', result_count: 0, error: 'public port blocked' }), env);
    const row = sqlite.prepare("SELECT * FROM iperf_enrollments WHERE server_id='new'").get();
    assert.equal(row.status, 'blocked'); assert.equal(row.error, 'public port blocked');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM iperf_targets').get().n, 0);
    sqlite.exec("UPDATE iperf_schedules SET enabled=1,time_beijing='22:10' WHERE server_id='new'");
    await handleIperfBootstrap(request('/bootstrap', { id: 'new', secret: 'monitor-test' }), env);
    assert.equal(sqlite.prepare("SELECT enabled FROM iperf_schedules WHERE server_id='new'").get().enabled, 1);
    assert.equal(sqlite.prepare("SELECT time_beijing FROM iperf_schedules WHERE server_id='new'").get().time_beijing, '22:10');
    assert.equal((await node({})).status, 401);
  } finally { sqlite.close(); }
});

test('领取响应丢失后按同一编号取回同一任务，完成回执可重复提交',async()=>{
 const {sqlite,env}=setup();try {
  const id=crypto.randomUUID(),other=crypto.randomUUID(),key=crypto.randomUUID();
  sqlite.exec("CREATE TABLE iperf_jobs(id TEXT PRIMARY KEY,server_id TEXT,source TEXT,status TEXT,duration_seconds INTEGER,scheduled_slot TEXT,created_at INTEGER,started_at INTEGER,finished_at INTEGER,error TEXT,result_count INTEGER)");
  sqlite.prepare("INSERT INTO iperf_jobs(id,server_id,source,status,duration_seconds,created_at) VALUES (?,?,'manual','queued',5,?)").run(id,'new',Date.now()-10);
  sqlite.prepare("INSERT INTO iperf_jobs(id,server_id,source,status,duration_seconds,created_at) VALUES (?,?,'manual','queued',5,?)").run(other,'other',Date.now());
  const a=await(await handleIperfClaim(runner({request_id:key}),env)).json();
  const b=await(await handleIperfClaim(runner({request_id:key}),env)).json();
  assert.equal(a.id,id);assert.equal(b.id,id);
  assert.equal(sqlite.prepare('SELECT status FROM iperf_jobs WHERE id=?').get(other).status,'queued');
  const payload={id,status:'completed',result_count:0,error:null};
  assert.equal((await handleIperfFinish(runner(payload),env)).status,200);
  const repeated=await(await handleIperfFinish(runner(payload),env)).json();assert.equal(repeated.already_applied,true);
  assert.equal((await(await handleIperfClaim(runner({request_id:key}),env)).json()).status,'completed');
 }finally{sqlite.close()}
});

test('旧领取丢失仅恢复未执行任务；租约过期的完成补报要求完整结果和清理确认',async()=>{
 const {sqlite,env}=setup();try {
  await handleIperfClaim(runner({}),env);
  const id=crypto.randomUUID(),key=crypto.randomUUID(),start=Date.now()-25*60000;
  sqlite.prepare("INSERT INTO iperf_jobs(id,server_id,source,status,duration_seconds,created_at,started_at) VALUES (?,'new','scheduled','running',5,?,?)").run(id,start,start);
  const recovered=await(await handleIperfClaim(runner({request_id:key,recover_job_id:id}),env)).json();assert.equal(recovered.id,id);
  sqlite.prepare("UPDATE iperf_jobs SET status='failed',finished_at=?,error='runner lease expired' WHERE id=?").run(Date.now(),id);
  const body={id,status:'completed',result_count:4,error:null,cleanup_confirmed:true};
  assert.equal((await handleIperfFinish(runner(body),env)).status,400);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS iperf_results(run_id TEXT,server_id TEXT,source TEXT,family TEXT,direction TEXT,tested_at INTEGER,duration_seconds INTEGER,port INTEGER,status TEXT,mbps REAL,retransmits INTEGER,error TEXT,PRIMARY KEY(run_id,server_id,family,direction))`);
  for(const family of ['ipv4','ipv6'])for(const direction of ['download','upload'])sqlite.prepare("INSERT INTO iperf_results VALUES ('run','new','deb',?,?,?,5,5202,'ok',100,0,NULL)").run(family,direction,sqlite.prepare('SELECT started_at FROM iperf_jobs WHERE id=?').get(id).started_at);
  assert.equal((await handleIperfFinish(runner({...body,cleanup_confirmed:false}),env)).status,400);
  assert.equal((await handleIperfFinish(runner(body),env)).status,200);
 }finally{sqlite.close()}
});
