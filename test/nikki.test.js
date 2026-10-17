import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceAlert,nikkiToken,handleNikkiReport,handleNikkiStatus,scoreProbe } from '../src/handlers/nikki.js';
import { DatabaseSync } from 'node:sqlite';
import { buildHistoryId } from '../src/database/indexOptimization.js';

test('在用线路连续低分五分钟才提醒，保持低分只触发一次，恢复需达到65分',()=>{
  let previous=null;
  for(let i=0;i<=5;i++) {
    const now=1000000+i*60000;
    const next=advanceAlert(previous,59,now);
    assert.equal(next.fire,i===5);
    previous={...next,observed_at:now};
  }
  previous.alerted=1;
  assert.equal(advanceAlert(previous,30,1360000).fire,false);
  assert.equal(advanceAlert(previous,63,1360000).alerted,1);
  assert.equal(advanceAlert(previous,65,1360000).alerted,0);
});
test('采集断档、缺失评分、短时恢复会重置连续低分计时',()=>{
  const previous={low_since:1000,observed_at:301000,alerted:0};
  assert.equal(advanceAlert(previous,null,361000).low_since,null);
  assert.equal(advanceAlert(previous,60,361000).low_since,null);
  assert.equal(advanceAlert(previous,20,500000).low_since,500000);
  assert.equal(advanceAlert(previous,0,361000).fire,true);
});
test('只接受独立派生的上报凭证，不能用探针/runner原密钥调用',async()=>{
  const token=await nikkiToken('test-runner-token');
  assert.match(token,/^[a-f0-9]{64}$/);
  assert.notEqual(token,await nikkiToken('other-token'));
  const req=new Request('https://example/api/nikki/report',{method:'POST',headers:{'X-Nikki-Token':'test-runner-token'},body:'{}'});
  assert.equal((await handleNikkiReport(req,{IPERF_REPORT_TOKEN:'test-runner-token'})).status,401);
  const malformed=new Request(req.url,{method:'POST',headers:{'X-Nikki-Token':token},body:JSON.stringify({observed_at:Date.now(),routes:[{server_id:'x',family:'ipv7',connections:1}],unknown_count:0})});
  assert.equal((await handleNikkiReport(malformed,{IPERF_REPORT_TOKEN:'test-runner-token'})).status,400);
});
test('对应双栈探针独立计算，100%失败不伪造有效延迟，未知丢包不补零',()=>{
  const rows=[{timestamp:1000,ping_node_1:70,loss_node_1:0,ping_node_2:200,loss_node_2:100},{timestamp:2000,ping_node_1:90,loss_node_1:2,ping_node_2:null,loss_node_2:100}];
  const v4=scoreProbe('ipv4',rows,{ping_node_1:90});
  assert.equal(v4.loss,1);assert.equal(v4.samples.length,2);
  const v6=scoreProbe('ipv6',rows,{});assert.equal(v6.samples.length,0);assert.equal(v6.loss,100);
  assert.equal(scoreProbe('ipv4',[],{}).loss,null);
});
test('上报到持久评分到公开徽章闭环：重放不重复，离开线路清空，删除节点不复活',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE servers (id TEXT PRIMARY KEY,name TEXT,is_hidden INTEGER,history_partition_id INTEGER,timestamp INTEGER,node_1 TEXT,node_2 TEXT);
    INSERT INTO servers VALUES ('vps','测试节点',0,1,0,'cm-v4:80','cm-v6:80');
    CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE metrics_history (id INTEGER PRIMARY KEY,timestamp INTEGER,ping_node_1 REAL,loss_node_1 REAL,ping_node_2 REAL,loss_node_2 REAL);`);
  const now=Date.now();
  for(let i=10;i>=0;i--)sqlite.prepare('INSERT INTO metrics_history VALUES (?,?,?,?,?,?)').run(buildHistoryId(1,now-i*60000),now-i*60000,70,0,80,0);
  const DB={prepare(sql){let args=[];return {bind(...v){args=v;return this;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:{changes:sqlite.prepare(sql).run(...args).changes}};}};},async batch(stmts){const rs=[];for(const stmt of stmts)rs.push(await stmt.run());return rs;}};
  const env={DB,IPERF_REPORT_TOKEN:'test-token'};
  const token=await nikkiToken(env.IPERF_REPORT_TOKEN);
  const body={observed_at:now,routes:[{server_id:'vps',family:'ipv4',connections:2}],unknown_count:0};
  const post=data=>handleNikkiReport(new Request('https://example/api/nikki/report',{method:'POST',headers:{'X-Nikki-Token':token},body:JSON.stringify(data)}),env);
  assert.equal((await post(body)).status,200);
  assert.equal((await (await post(body)).json()).replayed,true);
  const get=()=>handleNikkiStatus(new Request('https://example/api/nikki/status'),env,{is_public:'true'});
  let data=await (await get()).json();
  assert.equal(data.fresh,true);assert.equal(data.routes.length,1);assert.equal(data.routes[0].estimate.family,'ipv4');
  assert.equal(data.routes[0].score,null);assert.equal(data.routes[0].reason,'暂无测速');
  assert.equal('connections' in data.routes[0],false);
  await post({...body,observed_at:now+1,routes:[]});assert.equal((await (await get()).json()).routes.length,0);
  sqlite.prepare('DELETE FROM servers').run();
  await post({...body,observed_at:now+2});assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM nikki_routes').get().n,0);
  sqlite.close();
});
