import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { isDatabaseQuotaError,databaseQuotaResponse } from '../src/utils/databaseAvailability.js';
import { loadSiteSettings,loadAppearanceOptions,clearSiteSettingsCache,clearAppearanceSettingsCache } from '../src/utils/settings.js';
import { getAllServers,clearServersListCache } from '../src/utils/cache.js';
import { enqueueDueIperfJobs } from '../src/handlers/iperfJobs.js';
import { readFile } from 'node:fs/promises';
const limit=new Error("Your account has exceeded D1's free tier daily row read limit.");

test('D1额度错误不得返回空节点或默认站点权限，API和页面明确返回503',async()=>{
 const DB={prepare(){throw new Error('D1_ERROR',{cause:limit})}};
 clearSiteSettingsCache();clearAppearanceSettingsCache();clearServersListCache();
 assert.equal(isDatabaseQuotaError(new Error('wrapper',{cause:limit})),true);
 assert.equal(isDatabaseQuotaError(new Error('ordinary failure')),false);
 for(const load of [loadSiteSettings,loadAppearanceOptions,getAllServers])await assert.rejects(()=>load(DB),isDatabaseQuotaError);
 const api=databaseQuotaResponse(new Request('https://monitor.example/api/servers'));
 assert.equal(api.status,503);assert.equal((await api.json()).reason,'database_daily_limit');
 const page=databaseQuotaResponse(new Request('https://monitor.example/'));
 assert.equal(page.status,503);assert.match(await page.text(),/无需重新添加节点/);
});

test('调度审计时间清理使用索引，分钟调度不再反复全表清理',async()=>{
 const sql=[];const DB={prepare(query){sql.push(query);return {bind(){return this},async all(){return {results:[]}},async run(){return {meta:{changes:0}}}}}};
 await enqueueDueIperfJobs(DB,Date.now());
 assert.ok(sql.some(s=>s.includes('CREATE INDEX IF NOT EXISTS idx_iperf_dispatch_time')));
 assert.ok(!sql.some(s=>s.startsWith('DELETE FROM iperf_dispatch_audit')));
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE iperf_dispatch_audit(id TEXT PRIMARY KEY,observed_at INTEGER); CREATE INDEX idx_iperf_dispatch_time ON iperf_dispatch_audit(observed_at)');
 const plan=db.prepare('EXPLAIN QUERY PLAN DELETE FROM iperf_dispatch_audit WHERE observed_at<?').all(100);
 assert.ok(plan.some(row=>row.detail.includes('idx_iperf_dispatch_time')));db.close();
 const entry=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
 assert.match(entry,/if \(cron === '0 \* \* \* \*'\) \{[\s\S]*DELETE FROM iperf_dispatch_audit/);
});

test('任务列表、逐节点补测和监听查找在历史增长后仍使用相应索引',async()=>{
 const {ensureIperfJobTables}=await import('../src/handlers/iperfJobs.js');
 const {ensureAutoTables}=await import('../src/handlers/iperfAuto.js');
 const {ensureIperfResultsTable}=await import('../src/handlers/iperf.js');
 const db=new DatabaseSync(':memory:');
 const DB={prepare(sql){let args=[];return {bind(...v){args=v;return this},async all(){return {results:db.prepare(sql).all(...args)}},async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}}}}}};
 await ensureIperfJobTables(DB);await ensureAutoTables(DB);await ensureIperfResultsTable(DB);
 const job=db.prepare("INSERT INTO iperf_jobs(id,server_id,source,status,duration_seconds,created_at) VALUES (?,?,?,'completed',5,?)");
 db.exec('BEGIN');for(let i=0;i<3000;i++)job.run('job'+i,'server'+i%6,i%3?'manual':'refresh',i*60000);db.exec('COMMIT');
 for(const [sql,args,index] of [
  ["SELECT MAX(tested_at) FROM iperf_results WHERE server_id=? AND source='deb' AND family='ipv4'",['server1'],'idx_iperf_family_latest'],
  ['SELECT * FROM iperf_jobs ORDER BY created_at DESC LIMIT 100',[],'idx_iperf_job_created'],
  ['SELECT status FROM iperf_jobs WHERE server_id=? ORDER BY created_at DESC LIMIT 1',['server1'],'idx_iperf_job_server_time'],
  ["SELECT COUNT(*) FROM iperf_jobs WHERE server_id=? AND source='refresh' AND created_at>?",['server1',100000],'idx_iperf_refresh_time'],
  ["SELECT * FROM iperf_listeners WHERE server_id=? AND state IN ('preparing','ready') ORDER BY expires_at DESC LIMIT 1",['server1'],'idx_iperf_listener_server_expiry']
 ])assert.ok(db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).some(row=>row.detail.includes(index)),sql);
 db.close();
});
