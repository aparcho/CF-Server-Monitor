import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceAlert,nikkiToken,handleNikkiReport,handleNikkiStatus,scoreProbe } from '../src/handlers/nikki.js';
import { DatabaseSync } from 'node:sqlite';
import { clearAllCaches } from '../src/utils/cache.js';
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
    INSERT INTO servers VALUES ('vps','测试节点',0,1,0,NULL,NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE metrics_history (id INTEGER PRIMARY KEY,timestamp INTEGER,ping_node_1 REAL,loss_node_1 REAL,ping_node_2 REAL,loss_node_2 REAL);`);
  const now=Date.now();
  for(let i=10;i>=0;i--)sqlite.prepare('INSERT INTO metrics_history VALUES (?,?,?,?,?,?)').run(buildHistoryId(1,now-i*60000),now-i*60000,70,0,80,0);
  const DB={prepare(sql){let args=[];return {bind(...v){args=v;return this;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){const stmt=sqlite.prepare(sql);return /^SELECT/i.test(sql)?{results:stmt.all(...args)}:{meta:{changes:stmt.run(...args).changes}};}};},async batch(stmts){const rs=[];for(const stmt of stmts)rs.push(await stmt.run());return rs;}};
  let duringRead=null,release=null,entered=null;
  const originalPrepare=DB.prepare.bind(DB);
  DB.prepare=(sql)=>{const statement=originalPrepare(sql);if(sql==='SELECT * FROM servers WHERE id=?'){const first=statement.first.bind(statement);statement.first=async()=>{if(entered){const signal=entered;entered=null;signal();await new Promise(resolve=>{release=resolve;});}return first();};}return statement;};
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
  assert.equal(data.routes[0].estimate.probe.lastValue,70);
  assert.equal('connections' in data.routes[0],false);
  assert.equal(data.routes[0].active,true);assert.equal(data.routes[0].selected,false);
  const blocked=new Promise(resolve=>{entered=resolve;});
  const inFlight=post({...body,observed_at:now+1});
  await blocked;
  duringRead=await (await get()).json();
  assert.equal(duringRead.observed_at,now);assert.equal(duringRead.routes.length,1);
  // 后来的报告先完成，旧报告随后结束也不能覆盖新快照。
  await post({...body,observed_at:now+2,routes:[]});
  release();assert.equal((await (await inFlight).json()).replayed,true);
  assert.equal((await (await get()).json()).routes.length,0);
  await post({...body,observed_at:now+3});
  sqlite.prepare("UPDATE nikki_routes SET low_since=?,alerted=1 WHERE server_id='vps'").run(now-600000);
  const standby={...body,version:2,observed_at:now+4,routes:[{server_id:'vps',family:'ipv4',connections:0,selected:true}]};
  assert.equal((await post(standby)).status,200);
  data=await (await get()).json();assert.equal(data.routes[0].active,false);assert.equal(data.routes[0].selected,true);
  assert.equal(data.routes[0].low_since,null);assert.equal(data.routes[0].alerted,false);
  assert.equal((await post({...standby,observed_at:now+2,routes:[{...standby.routes[0],selected:false}]})).status,400);
  assert.equal((await post({...standby,observed_at:now+2,routes:[{...standby.routes[0],selected:undefined}]})).status,400);
  const exitOnly={...body,version:3,observed_at:now+5,routes:[{server_id:'vps',family:'ipv4',connections:0,selected:false,exit_connections:1}]};
  assert.equal((await post(exitOnly)).status,200);
  data=await (await get()).json();assert.equal(data.routes[0].active,false);assert.equal(data.routes[0].exit_active,true);
  assert.equal(data.routes[0].low_since,null);assert.equal(data.routes[0].alerted,false);
  assert.equal((await post({...exitOnly,observed_at:now+6,routes:[{...exitOnly.routes[0],exit_connections:-1}]})).status,400);
  assert.equal((await post({...exitOnly,observed_at:now+6,routes:[{...exitOnly.routes[0],exit_connections:0}]})).status,400);
  // INTEGER 亲和列仍须保存小数；同时核实公开状态与持久化评分完全一致。
  for(const [direction,mbps] of [['download',600],['upload',200]])sqlite.prepare(`INSERT INTO iperf_results
    (run_id,server_id,source,family,direction,tested_at,duration_seconds,port,status,mbps,retransmits)
    VALUES ('precision','vps','deb','ipv4',?,?,5,5202,'ok',?,0)`).run(direction,now,mbps);
  await post({...exitOnly,observed_at:now+6});
  data=await (await get()).json();
  const saved=sqlite.prepare("SELECT score FROM nikki_routes WHERE server_id='vps'").get().score;
  assert.equal(data.routes[0].estimate.modelVersion,7);
  assert.equal(Number.isInteger(saved),false);
  assert.equal(saved,data.routes[0].score);assert.equal(saved,data.routes[0].estimate.score);
  assert.ok(Math.abs(saved*10-Math.round(saved*10))<1e-8);
  clearAllCaches();
  let historyReads=0,speedReads=0;
  const countedPrepare=DB.prepare.bind(DB);
  DB.prepare=sql=>{
    if(sql.includes('WITH history_rows AS'))historyReads++;
    if(sql==='SELECT * FROM iperf_results WHERE server_id=? ORDER BY tested_at DESC LIMIT 80')speedReads++;
    const statement=countedPrepare(sql);
    if(sql.includes('WITH history_rows AS')){
      const bind=statement.bind.bind(statement);
      statement.bind=(...args)=>{assert.ok(args[0]>=buildHistoryId(1,Date.now()-11*60000));return bind(...args);};
    }
    return statement;
  };
  await post({...body,observed_at:now+7,routes:[{server_id:'vps',family:'ipv4',connections:1},{server_id:'vps',family:'ipv6',connections:1}]});
  assert.equal(historyReads,1);assert.equal(speedReads,1);
  data=await (await get()).json();assert.equal(data.routes.length,2);
  await post({...body,observed_at:now+8,routes:[]});assert.equal((await (await get()).json()).routes.length,0);
  sqlite.prepare('DELETE FROM servers').run();
  await post({...body,observed_at:now+9});assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM nikki_routes').get().n,0);
  sqlite.close();
});
