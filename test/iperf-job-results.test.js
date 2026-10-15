import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureIperfJobTables } from '../src/handlers/iperfJobs.js';
import { ensureIperfResultsTable, getIperfJobResults } from '../src/handlers/iperf.js';
const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));

test('任务明细匹配执行窗口，隔离节点与批次，保留失败方向和清理失败时的结果', {skip:!DatabaseSync}, async()=>{
  const sqlite=new DatabaseSync(':memory:');
  const db={prepare(sql){let args=[];return {bind(...a){args=a;return this},async run(){return sqlite.prepare(sql).run(...args)},async all(){return {results:sqlite.prepare(sql).all(...args)}},async first(){return sqlite.prepare(sql).get(...args)}}}};
  try {
    await ensureIperfJobTables(db); await ensureIperfResultsTable(db);
    const job=sqlite.prepare('INSERT INTO iperf_jobs (id,server_id,source,status,duration_seconds,created_at,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?)');
    job.run('one','a','scheduled','completed',5,90,100,200);
    job.run('two','a','manual','failed',5,210,220,300);
    job.run('ambiguous','a','manual','completed',5,310,320,400);
    job.run('onboard','a','onboarding','completed',5,410,420,500);
    job.run('empty','a','scheduled','completed',5,510,520,600);
    const row=sqlite.prepare('INSERT INTO iperf_results VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const put=(run,node,time,status='ok',direction='download',duration=5)=>row.run(run,node,'deb','ipv4',direction,time,duration,5202,status,status==='ok'?123.45:null,status==='ok'?12:null,status==='ok'?null:'timeout');
    put('old','a',80); put('wrong-node','b',150); put('wrong-duration','a',150,'ok','download',10);
    put('run1','a',120); put('run1','a',130,'failed','upload');
    put('run2','a',250); put('run3','a',350);put('run4','a',360);put('onboard-run','a',450);
    const groups=await getIperfJobResults(db);
    assert.deepEqual(groups.get('one').map(r=>r.run_id),['run1','run1']);
    assert.equal(groups.get('one')[1].status,'failed');
    assert.equal(groups.get('two')[0].mbps,123.45);
    assert.deepEqual(groups.get('ambiguous'),[]);
    assert.equal(groups.has('onboard'),false);
    assert.equal(groups.has('empty'),false);
  } finally {sqlite.close()}
});
