import { checkAuth } from '../middleware/auth.js';
import { createSuccessResponse,createBadRequestResponse,createUnauthorizedResponse } from '../utils/errors.js';
import { ensureIperfResultsTable } from './iperf.js';

const ID=/^[a-zA-Z0-9._:-]{1,100}$/;
const HOUR=3600000;
const validId=x=>typeof x==='string'&&ID.test(x);
export async function ensureNetwatch(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS netwatch_samples(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,
      tested_at INTEGER NOT NULL,kind TEXT NOT NULL,family TEXT NOT NULL,direction TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_netwatch_time ON netwatch_samples(server_id,tested_at)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS netwatch_nodes(server_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL,
      iperf_capable INTEGER NOT NULL,reason TEXT,interval_seconds INTEGER NOT NULL DEFAULT 300,
      daily_budget_mib INTEGER NOT NULL DEFAULT 512,last_seen INTEGER NOT NULL,budget_day TEXT,
      payload_bytes INTEGER DEFAULT 0,reserved_bytes INTEGER DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)`)
  ]);
}
const finite=(x,min,max)=>typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max;
export function validateSample(s,now=Date.now()) {
  if(!s||!validId(s.id)||!validId(s.server_id)||!Number.isSafeInteger(s.tested_at)||s.tested_at>now+60000||s.tested_at<now-30*24*HOUR||
    !['quality','sentinel','confirm'].includes(s.kind)||!['ipv4','ipv6'].includes(s.family)||
    !['both','download','upload'].includes(s.direction)||!['ok','failed','timeout','tcp_failed','route_blocked','error','tool_error'].includes(s.status)||!s.data||typeof s.data!=='object')return null;
  const d=s.data;
  let data;
  if(s.kind==='quality') {
    if(s.direction!=='both')return null;
    if(d.ping_sent!=null&&(!Number.isInteger(d.ping_sent)||d.ping_sent<0||d.ping_sent>100))return null;
    if(d.ping_received!=null&&(!Number.isInteger(d.ping_received)||d.ping_received<0||d.ping_received>(d.ping_sent||0)))return null;
    if(d.tcp_ms!=null&&!finite(d.tcp_ms,0,60000))return null;
    if(d.ping_ms!=null&&(!Array.isArray(d.ping_ms)||d.ping_ms.length>100||d.ping_ms.some(x=>!finite(x,0,60000))))return null;
    data={ping_sent:d.ping_sent??0,ping_received:d.ping_received??0,ping_ms:d.ping_ms??[],tcp_ms:d.tcp_ms??null,tcp_port:d.tcp_port??null};
  } else {
    if(s.direction==='both'||!finite(d.target_bps,100000,50000000))return null;
    if(s.status==='ok'&&(!finite(d.mbps,0,100000)||!Number.isSafeInteger(d.payload_bytes)||d.payload_bytes<0))return null;
    if(d.retransmits!=null&&(!Number.isSafeInteger(d.retransmits)||d.retransmits<0))return null;
    data={mbps:d.mbps??null,retransmits:d.retransmits??null,target_bps:d.target_bps,payload_bytes:d.payload_bytes??null,
      seconds:finite(d.seconds,0,120)?d.seconds:null,tcp_rtt_ms:finite(d.tcp_rtt_ms,0,60000)?d.tcp_rtt_ms:null,
      port_closed:d.cleanup?.port_closed===true,cleanup_ok:d.cleanup?.cleaned===true};
  }
  // 不上传管理主机、密钥路径、命令行及原始日志。
  return {id:s.id,server_id:s.server_id,tested_at:s.tested_at,kind:s.kind,family:s.family,direction:s.direction,status:s.status,data};
}
export async function handleNetwatchReport(request,env) {
  if(!env.IPERF_REPORT_TOKEN||request.headers.get('X-Iperf-Token')!==env.IPERF_REPORT_TOKEN)return createUnauthorizedResponse();
  let body;try{body=await request.json()}catch{return createBadRequestResponse('invalidJson')}
  if(!body||!Array.isArray(body.samples)||body.samples.length>80||!Array.isArray(body.nodes)||body.nodes.length>20)return createBadRequestResponse('invalidNetwatchBatch');
  const samples=body.samples.map(s=>validateSample(s));
  if(samples.some(s=>!s))return createBadRequestResponse('invalidNetwatchSample');
  if(body.nodes.some(n=>!n||!validId(n.server_id)||typeof n.enabled!=='boolean'||typeof n.iperf_capable!=='boolean'||
    !Number.isInteger(n.daily_budget_mib)||n.daily_budget_mib<16||n.daily_budget_mib>10240||
    !finite(n.payload_bytes,0,1e15)||!finite(n.reserved_bytes,0,1e15)||!/^\d{4}-\d{2}-\d{2}$/.test(n.budget_day||'')))return createBadRequestResponse('invalidNetwatchNode');
  await ensureNetwatch(env.DB);
  const servers=new Set((await env.DB.prepare('SELECT id FROM servers').all()).results.map(s=>s.id));
  const statements=[];const now=Date.now();
  for(const n of body.nodes.filter(n=>servers.has(n.server_id)))statements.push(env.DB.prepare(`INSERT INTO netwatch_nodes
    (server_id,enabled,iperf_capable,reason,interval_seconds,daily_budget_mib,last_seen,budget_day,payload_bytes,reserved_bytes)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET iperf_capable=excluded.iperf_capable,reason=excluded.reason,
      last_seen=excluded.last_seen,budget_day=excluded.budget_day,payload_bytes=excluded.payload_bytes,reserved_bytes=excluded.reserved_bytes`)
    .bind(n.server_id,n.enabled?1:0,n.iperf_capable?1:0,String(n.reason||'').slice(0,160),300,n.daily_budget_mib,now,n.budget_day,n.payload_bytes,n.reserved_bytes));
  for(const s of samples.filter(s=>servers.has(s.server_id)))statements.push(env.DB.prepare(`INSERT OR IGNORE INTO netwatch_samples VALUES (?,?,?,?,?,?,?,?)`)
    .bind(s.id,s.server_id,s.tested_at,s.kind,s.family,s.direction,s.status,JSON.stringify(s.data)));
  if(statements.length)await env.DB.batch(statements);
  const settings=(await env.DB.prepare('SELECT server_id,enabled,interval_seconds,daily_budget_mib FROM netwatch_nodes').all()).results;
  // 每小时最多一次清理，避免每个上报批次扫描历史。
  if(now%HOUR<60000)await env.DB.prepare('DELETE FROM netwatch_samples WHERE tested_at<?').bind(now-30*24*HOUR).run();
  return createSuccessResponse({success:true,accepted:body.samples.length,settings});
}
const decode=r=>({...r,data:JSON.parse(r.data)});
const median=a=>{const b=[...a].sort((x,y)=>x-y);return b.length?b[Math.floor(b.length/2)]:null};
export function compareLane(regular,samples,now=Date.now()) {
  if(!regular)return {state:'awaiting_regular',label:'暂无常规测速',regular:null,sample_count:0};
  const nearby=samples.filter(s=>s.kind!=='quality'&&s.status!=='tool_error'&&s.family===regular.family&&s.direction===regular.direction&&Math.abs(s.tested_at-regular.tested_at)<=30*60000);
  const recent=nearby.filter(s=>s.kind==='sentinel');
  const valid=recent.filter(s=>s.status==='ok');
  const target=median(valid.map(s=>s.data.target_bps/1e6));
  const low=valid.filter(s=>s.data.mbps<s.data.target_bps/1e6*.65).length;
  const bad=recent.filter(s=>s.status!=='ok').length;
  const base={regular,sample_count:recent.length,matched_from:nearby.length?Math.min(...nearby.map(s=>s.tested_at)):null,
    matched_to:nearby.length?Math.max(...nearby.map(s=>s.tested_at)):null,target_mbps:target,
    probe_median_mbps:median(valid.map(s=>s.data.mbps)),low_count:low,failed_count:bad,
    confirmation:nearby.filter(s=>s.kind==='confirm').sort((a,b)=>b.tested_at-a.tested_at)[0]||null,
    stale:now-regular.tested_at>24*HOUR};
  if(!recent.length)return {...base,state:'awaiting_probe',label:'缺少同期持续探测'};
  if(regular.status!=='ok')return {...base,state:'regular_failed',label:'常规测速失败，无法比较容量'};
  if(valid.length<2)return {...base,state:'insufficient',label:'同期有效探测不足两次'};
  const probeBad=low/valid.length>=.5;
  const regularBad=regular.mbps<target*.65;
  if(probeBad&&regularBad)return {...base,state:'confirmed_low',label:'两类测试均显示低速'};
  if(probeBad!==regularBad)return {...base,state:'inconsistent',label:'结果不一致，检查时段与短样本起步影响'};
  if(bad)return {...base,state:'intermittent',label:'容量正常，但持续探测有间歇失败'};
  return {...base,state:'consistent',label:'探测档位达标，常规测速验证容量'};
}
export async function netwatchData(env,id,hours=24) {
  await ensureNetwatch(env.DB);await ensureIperfResultsTable(env.DB);
  const now=Date.now(),cutoff=now-hours*HOUR;
  const [samples,node,regular]=await Promise.all([
    env.DB.prepare(`SELECT id,server_id,tested_at,kind,family,direction,status,data FROM (
      SELECT *,ROW_NUMBER() OVER(PARTITION BY kind,family,direction,CAST(tested_at/CASE WHEN kind='quality' THEN ? ELSE 1 END AS INTEGER) ORDER BY tested_at DESC,id DESC) AS rn
      FROM netwatch_samples WHERE server_id=? AND tested_at>?) WHERE rn=1 ORDER BY tested_at DESC LIMIT 3000`)
      .bind(hours<=6?60000:300000,id,cutoff).all(),
    env.DB.prepare('SELECT * FROM netwatch_nodes WHERE server_id=?').bind(id).first(),
    env.DB.prepare('SELECT * FROM iperf_results WHERE server_id=? ORDER BY tested_at DESC LIMIT 80').bind(id).all()
  ]);
  const rows=(samples.results||[]).map(decode);
  const comparisons=[];
  for(const family of ['ipv4','ipv6'])for(const direction of ['download','upload']) {
    const latestRun=(regular.results||[]).find(r=>r.family===family)?.run_id;
    const latest=(regular.results||[]).find(r=>r.run_id===latestRun&&r.family===family&&r.direction===direction);
    comparisons.push({family,direction,...compareLane(latest,rows,now)});
  }
  return {node:node||null,samples:rows,comparisons,server_time:now,hours};
}
export async function handleNetwatchResults(request,env,sys) {
  if(sys.is_public!=='true'&&!await checkAuth(request,env,sys))return createUnauthorizedResponse();
  const url=new URL(request.url),id=url.searchParams.get('id'),hours=Number(url.searchParams.get('hours')||24);
  if(!validId(id||'')||![1,6,24,72].includes(hours))return createBadRequestResponse('invalidNetwatchQuery');
  return createSuccessResponse(await netwatchData(env,id,hours));
}
export async function handleNetwatchAdmin(data,env) {
  await ensureNetwatch(env.DB);
  if(data.action==='netwatch_list')return createSuccessResponse({nodes:(await env.DB.prepare('SELECT * FROM netwatch_nodes').all()).results});
  if(data.action!=='netwatch_configure'||!validId(data.server_id||'')||typeof data.enabled!=='boolean'||
    ![120,300,600,900].includes(data.interval_seconds)||!Number.isInteger(data.daily_budget_mib)||data.daily_budget_mib<16||data.daily_budget_mib>10240)return createBadRequestResponse('invalidNetwatchConfig');
  const node=await env.DB.prepare('SELECT server_id FROM netwatch_nodes WHERE server_id=?').bind(data.server_id).first();
  if(!node)return createBadRequestResponse('netwatchNodeNotEnrolled');
  await env.DB.prepare('UPDATE netwatch_nodes SET enabled=?,interval_seconds=?,daily_budget_mib=?,updated_at=? WHERE server_id=?')
    .bind(data.enabled?1:0,data.interval_seconds,data.daily_budget_mib,Date.now(),data.server_id).run();
  return createSuccessResponse({success:true});
}
