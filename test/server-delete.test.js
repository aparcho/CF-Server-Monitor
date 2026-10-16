import { handleNetwatchRetired } from '../src/handlers/netwatchRetired.js';
import { deleteServers } from '../src/utils/deleteServers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleIperfTargets } from '../src/handlers/iperfJobs.js';
function database(){const raw=new DatabaseSync(':memory:');raw.exec('CREATE TABLE servers(id TEXT PRIMARY KEY); INSERT INTO servers VALUES (\'one\'),(\'two\')');const db={prepare(sql){let args=[];return{bind(...a){args=a;return this},async run(){const r=raw.prepare(sql).run(...args);return {meta:{changes:r.changes}}},async all(){return {results:raw.prepare(sql).all(...args)}},async first(){return raw.prepare(sql).get(...args)||null}}},async batch(statements){raw.exec('BEGIN');try{const rows=[];for(const s of statements)rows.push(await s.run());raw.exec('COMMIT');return rows}catch(e){raw.exec('ROLLBACK');throw e}}};return{raw,db}}
const request=body=>new Request('https://monitor.test/api/netwatch/report',{method:'POST',headers:{'X-Iperf-Token':'test'},body:JSON.stringify(body)});
test('自动登记与 deb 刷新同节点无主键冲突，事务刷新不删除其他自动节点',async()=>{const {raw,db}=database();try{const env={DB:db,IPERF_REPORT_TOKEN:'test'};await handleIperfTargets(new Request('https://x',{method:'POST',headers:{'X-Iperf-Token':'test'},body:JSON.stringify({server_ids:['one']})}),env);raw.exec("UPDATE iperf_targets SET source='auto'; INSERT INTO iperf_targets VALUES ('two','auto',1)");const r=await handleIperfTargets(new Request('https://x',{method:'POST',headers:{'X-Iperf-Token':'test'},body:JSON.stringify({server_ids:['one']})}),env);assert.equal(r.status,200);assert.equal(raw.prepare('SELECT COUNT(*) n FROM iperf_targets').get().n,2);assert.equal(raw.prepare("SELECT source FROM iperf_targets WHERE server_id='one'").get().source,'deb')}finally{raw.close()}});

test('删除节点原子清理测速与历史，deb 刷新自动移除已删目标，迟到上报不能复活',async()=>{
 const {raw,db}=database();try {
  const env={DB:db,IPERF_REPORT_TOKEN:'test'};
  raw.exec("CREATE TABLE _cf_KV(server_id TEXT); INSERT INTO _cf_KV VALUES ('one')");
  const prepare=db.prepare; db.prepare=(sql)=>{if(/PRAGMA.*_cf_KV/i.test(sql))throw new Error('D1_ERROR: not authorized: SQLITE_AUTH');return prepare(sql)};
  raw.exec("CREATE TABLE netwatch_samples(server_id TEXT); INSERT INTO netwatch_samples VALUES ('one')");
  await handleIperfTargets(request({server_ids:['one','two']}),env);
  raw.exec("CREATE TABLE metrics_history(server_id TEXT,value TEXT); INSERT INTO metrics_history VALUES ('one','a'),('two','b'); INSERT INTO iperf_schedules(server_id,updated_at) VALUES ('one',1),('two',1); INSERT INTO iperf_jobs(id,server_id,source,status,duration_seconds,created_at) VALUES ('job','one','manual','running',5,1)");
  await assert.rejects(deleteServers(db,['one','two']),e=>e.code===409);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM servers').get().n,2);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM deleted_servers').get().n,0);
  raw.exec("UPDATE iperf_jobs SET status='completed'");
  await deleteServers(db,['one']);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM _cf_KV').get().n,1);
  for(const table of ['iperf_jobs','iperf_targets','iperf_schedules','netwatch_samples','metrics_history'])
    assert.equal(raw.prepare(`SELECT COUNT(*) n FROM ${table} WHERE server_id='one'`).get().n,0);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM metrics_history WHERE server_id='two'").get().n,1);
  const refresh=await (await handleIperfTargets(request({server_ids:['one','two']}),env)).json();
  assert.deepEqual(refresh.deleted_ids,['one']);assert.equal(refresh.count,1);
  await deleteServers(db,['two']);assert.equal(raw.prepare('SELECT COUNT(*) n FROM servers').get().n,0);
 }finally{raw.close()}
});

test('持续探测退役只清理专属表、鉴权失败不清理、重复退役幂等',async()=>{
 const {raw,db}=database();try {
  const env={DB:db,IPERF_REPORT_TOKEN:'test'};
  await handleIperfTargets(request({server_ids:['one']}),env);
  raw.exec('CREATE TABLE netwatch_samples(id TEXT); CREATE TABLE netwatch_nodes(id TEXT); CREATE TABLE netwatch_meta(id TEXT)');
  assert.equal((await handleNetwatchRetired(new Request('https://x',{method:'POST'}),env)).status,401);
  assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE name='netwatch_samples'").get());
  for(let i=0;i<2;i++)assert.equal((await handleNetwatchRetired(request({}),env)).status,410);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('netwatch_samples','netwatch_nodes','netwatch_meta')").get().n,0);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM iperf_targets').get().n,1);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM servers').get().n,2);
 }finally{raw.close()}
});
