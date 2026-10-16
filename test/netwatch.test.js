import { deleteServers } from '../src/utils/deleteServers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleIperfTargets } from '../src/handlers/iperfJobs.js';
import { handleNetwatchReport,handleNetwatchAdmin,netwatchData,compareLane,validateSample } from '../src/handlers/netwatch.js';
function database(){const raw=new DatabaseSync(':memory:');raw.exec('CREATE TABLE servers(id TEXT PRIMARY KEY); INSERT INTO servers VALUES (\'one\'),(\'two\')');const db={prepare(sql){let args=[];return{bind(...a){args=a;return this},async run(){const r=raw.prepare(sql).run(...args);return {meta:{changes:r.changes}}},async all(){return {results:raw.prepare(sql).all(...args)}},async first(){return raw.prepare(sql).get(...args)||null}}},async batch(statements){raw.exec('BEGIN');try{const rows=[];for(const s of statements)rows.push(await s.run());raw.exec('COMMIT');return rows}catch(e){raw.exec('ROLLBACK');throw e}}};return{raw,db}}
const now=Date.now();const sample=(id='a')=>({id,server_id:'one',tested_at:now,kind:'sentinel',family:'ipv4',direction:'download',status:'ok',data:{mbps:2,target_bps:2000000,payload_bytes:262144,retransmits:0,raw:'/root/private-file'}});
const request=body=>new Request('https://monitor.test/api/netwatch/report',{method:'POST',headers:{'X-Iperf-Token':'test'},body:JSON.stringify(body)});
test('自动登记与 deb 刷新同节点无主键冲突，事务刷新不删除其他自动节点',async()=>{const {raw,db}=database();try{const env={DB:db,IPERF_REPORT_TOKEN:'test'};await handleIperfTargets(new Request('https://x',{method:'POST',headers:{'X-Iperf-Token':'test'},body:JSON.stringify({server_ids:['one']})}),env);raw.exec("UPDATE iperf_targets SET source='auto'; INSERT INTO iperf_targets VALUES ('two','auto',1)");const r=await handleIperfTargets(new Request('https://x',{method:'POST',headers:{'X-Iperf-Token':'test'},body:JSON.stringify({server_ids:['one']})}),env);assert.equal(r.status,200);assert.equal(raw.prepare('SELECT COUNT(*) n FROM iperf_targets').get().n,2);assert.equal(raw.prepare("SELECT source FROM iperf_targets WHERE server_id='one'").get().source,'deb')}finally{raw.close()}});
test('重复上报幂等、私有字段剔除、后台设置不会被采集器覆盖',async()=>{const {raw,db}=database();try{const env={DB:db,IPERF_REPORT_TOKEN:'test'};const body={samples:[sample()],nodes:[{server_id:'one',enabled:true,iperf_capable:true,daily_budget_mib:512,payload_bytes:100,reserved_bytes:200,budget_day:'2026-10-16'}]};assert.equal((await handleNetwatchReport(request(body),env)).status,200);assert.equal((await handleNetwatchReport(request(body),env)).status,200);assert.equal(raw.prepare('SELECT COUNT(*) n FROM netwatch_samples').get().n,1);assert.equal(JSON.parse(raw.prepare('SELECT data FROM netwatch_samples').get().data).raw,undefined);await handleNetwatchAdmin({action:'netwatch_configure',server_id:'one',enabled:false,interval_seconds:600,daily_budget_mib:256},env);const r=await (await handleNetwatchReport(request(body),env)).json();assert.equal(r.settings[0].enabled,0);assert.equal(r.settings[0].interval_seconds,600);assert.equal((await netwatchData(env,'one',24)).samples.length,1)}finally{raw.close()}});
test('限速2 Mbps与常规200 Mbps属于一致，不计算99%降速；不同时间不强行配对',()=>{const regular={family:'ipv4',direction:'download',tested_at:now,status:'ok',mbps:200};const probes=[sample('a'),sample('b')];assert.equal(compareLane(regular,probes,now).state,'consistent');assert.equal(compareLane({...regular,tested_at:now-2*3600000},probes,now).state,'awaiting_probe');assert.equal(compareLane({...regular,mbps:.5},probes.map(s=>({...s,data:{...s.data,mbps:.5}})),now).state,'confirmed_low');assert.equal(compareLane(regular,probes.map(s=>({...s,data:{...s.data,mbps:.5}})),now).state,'inconsistent')});
test('缺少标识和非法速率拒绝，缺少重传保留未知不补零',()=>{assert.equal(validateSample({...sample(),server_id:undefined}),null);assert.equal(validateSample({...sample(),data:{...sample().data,target_bps:0}}),null);assert.equal(validateSample({...sample(),data:{...sample().data,retransmits:null}}).data.retransmits,null)});

test('删除节点原子清理测速与历史，deb 刷新自动移除已删目标，迟到上报不能复活',async()=>{
 const {raw,db}=database();try {
  const env={DB:db,IPERF_REPORT_TOKEN:'test'};
  await handleNetwatchReport(request({samples:[sample()],nodes:[]}),env);
  await handleIperfTargets(request({server_ids:['one','two']}),env);
  raw.exec("CREATE TABLE metrics_history(server_id TEXT,value TEXT); INSERT INTO metrics_history VALUES ('one','a'),('two','b'); INSERT INTO iperf_schedules(server_id,updated_at) VALUES ('one',1),('two',1); INSERT INTO iperf_jobs(id,server_id,source,status,duration_seconds,created_at) VALUES ('job','one','manual','running',5,1)");
  await assert.rejects(deleteServers(db,['one','two']),e=>e.code===409);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM servers').get().n,2);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM deleted_servers').get().n,0);
  raw.exec("UPDATE iperf_jobs SET status='completed'");
  await deleteServers(db,['one']);
  for(const table of ['iperf_jobs','iperf_targets','iperf_schedules','netwatch_samples','metrics_history'])
    assert.equal(raw.prepare(`SELECT COUNT(*) n FROM ${table} WHERE server_id='one'`).get().n,0);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM metrics_history WHERE server_id='two'").get().n,1);
  const refresh=await (await handleIperfTargets(request({server_ids:['one','two']}),env)).json();
  assert.deepEqual(refresh.deleted_ids,['one']);assert.equal(refresh.count,1);
  const late=await(await handleNetwatchReport(request({samples:[sample('late')],nodes:[]}),env)).json();
  assert.deepEqual(late.deleted_ids,['one']);assert.equal(raw.prepare('SELECT COUNT(*) n FROM netwatch_samples').get().n,0);
  await deleteServers(db,['two']);assert.equal(raw.prepare('SELECT COUNT(*) n FROM servers').get().n,0);
 }finally{raw.close()}
});
