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
