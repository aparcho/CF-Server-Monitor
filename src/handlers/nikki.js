import { checkAuth } from '../middleware/auth.js';
import { createBadRequestResponse as bad, createSuccessResponse as ok, createUnauthorizedResponse as denied } from '../utils/errors.js';
import { getLatestMetrics, getMetricsHistory } from '../database/schema.js';
import { estimateNetwork } from '../utils/networkEstimate.js';
import { ensureIperfResultsTable } from './iperf.js';
import { loadSettings } from '../utils/settings.js';
import { sendNotification } from '../services/notification.js';

export const POLICY = { threshold: 60, recover: 65, hold_ms: 300000, stale_ms: 150000 };
const ID = /^[a-zA-Z0-9._:-]{1,100}$/;
export async function nikkiToken(secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('cfsm-nikki-report-v1')))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function ensureNikkiTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS nikki_monitor (id INTEGER PRIMARY KEY CHECK(id=1), observed_at INTEGER NOT NULL, unknown_count INTEGER NOT NULL)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS nikki_routes (
    server_id TEXT NOT NULL, family TEXT NOT NULL, observed_at INTEGER NOT NULL, connections INTEGER NOT NULL,
    score INTEGER, reason TEXT, estimate TEXT, low_since INTEGER, alerted INTEGER NOT NULL DEFAULT 0,
    evaluated_at INTEGER NOT NULL DEFAULT 0, notification_error TEXT,
    PRIMARY KEY(server_id,family))`).run();
  const columns=(await db.prepare('PRAGMA table_info(nikki_routes)').all()).results||[];
  if(!columns.some(c=>c.name==='selected')) {
    try {await db.prepare('ALTER TABLE nikki_routes ADD COLUMN selected INTEGER NOT NULL DEFAULT 0').run();}
    catch(error) {if(!/duplicate column name/i.test(error.message||''))throw error;}
  }
}
// 无效分数和采集断档会打断连续低分计时，已触发的事件在恢复阈值前保留。
export function advanceAlert(previous, score, now) {
  const contiguous = previous && now-previous.observed_at <= POLICY.stale_ms;
  const alerted = contiguous ? !!previous.alerted : false;
  if (score == null) return { low_since:null, alerted:alerted?1:0, fire:false };
  if (score >= POLICY.recover) return { low_since:null, alerted:0, fire:false };
  if (score >= POLICY.threshold) return { low_since:null, alerted:alerted?1:0, fire:false };
  const low_since = contiguous && previous.low_since != null ? previous.low_since : now;
  return { low_since, alerted:alerted?1:0, fire:!alerted && now-low_since >= POLICY.hold_ms };
}
export function scoreProbe(family, rows, metrics) {
  const field=family==='ipv4'?'node_1':'node_2';
  const samples=[],emptyTimes=[],lossSamples=[];
  let lossSum=0,count=0;
  for(const row of rows) {
    const value=row[`ping_${field}`], loss=row[`loss_${field}`];
    if(typeof loss==='number' && Number.isFinite(loss) && loss>=0 && loss<=100) {lossSum+=loss;count++;lossSamples.push({time:row.timestamp,loss});}
    if(typeof value==='number' && Number.isFinite(value) && value>=0 && loss!==100) samples.push({time:row.timestamp,value,loss});
    else emptyTimes.push(row.timestamp);
  }
  return {taskName:family==='ipv4'?'移动V4':'移动V6',lastValue:typeof metrics?.[`ping_${field}`]==='number'?metrics[`ping_${field}`]:null,
    loss:count?lossSum/count:null,samples,emptyTimes,lossSamples,loadState:'ready'};
}
async function evaluateRoute(db, route, server, now) {
  const metrics=await getLatestMetrics(db,server.id,server);
  const fields=['ping_node_1','loss_node_1','ping_node_2','loss_node_2'];
  const rows=await getMetricsHistory(db,server.id,2,fields.join(','),server);
  const results=(await db.prepare('SELECT * FROM iperf_results WHERE server_id=? ORDER BY tested_at DESC LIMIT 80').bind(server.id).all()).results||[];
  // 节点可继承全局探针配置，不能用 servers.node_N 为空来判定未配置；以该字段实测样本为准。
  return estimateNetwork(route.family,[scoreProbe(route.family,rows,metrics)],results,now,!metrics || now-metrics.timestamp>300000);
}
export async function handleNikkiReport(request,env) {
  const token=request.headers.get('X-Nikki-Token');
  if(!env.IPERF_REPORT_TOKEN || token!==await nikkiToken(env.IPERF_REPORT_TOKEN)) return denied();
  const body=await request.json().catch(()=>null),now=Date.now();
  if(!body || !Number.isSafeInteger(body.observed_at) || Math.abs(now-body.observed_at)>120000 || !Array.isArray(body.routes) || body.routes.length>64 || !Number.isInteger(body.unknown_count) || body.unknown_count<0) return bad('invalidNikkiReport');
  const version=body.version??1;
  if(![1,2].includes(version))return bad('invalidNikkiReportVersion');
  if(body.routes.some(r=>!r || !ID.test(r.server_id||'') || !['ipv4','ipv6'].includes(r.family) || !Number.isSafeInteger(r.connections)
    || r.connections<(version===2?0:1) || r.connections>100000 || (version===2 && (typeof r.selected!=='boolean' || (!r.selected && r.connections===0))))) return bad('invalidNikkiRoute');
  if(new Set(body.routes.map(r=>`${r.server_id}/${r.family}`)).size!==body.routes.length) return bad('duplicateNikkiRoute');
  await ensureNikkiTables(env.DB);await ensureIperfResultsTable(env.DB);
  const previous=(await env.DB.prepare('SELECT * FROM nikki_routes').all()).results||[];
  const published=await env.DB.prepare('SELECT * FROM nikki_monitor WHERE id=1').first();
  if(published && published.observed_at>=body.observed_at) return ok({success:true,replayed:true});
  const settings=await loadSettings(env.DB),evaluated=[];
  for(const route of body.routes) {
    const server=await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(route.server_id).first();
    if(!server) continue;
    const old=previous.find(p=>p.server_id===route.server_id && p.family===route.family);
    let estimate;
    try {estimate=await evaluateRoute(env.DB,route,server,now);} catch(error) {console.error('[Nikki] score failed',route.server_id,error.message);estimate={...estimateNetwork(route.family,[],[],now,false),reason:'评分数据读取失败'};}
    const state=route.connections>0?advanceAlert(old,estimate.score,body.observed_at):{low_since:null,alerted:0,fire:false};
    let notification_error=null;
    if(state.fire) {
      const configured=settings.notification_webhook_enabled==='true' || !!settings.tg_bot_token;
      if(configured) {
        notification_error=await sendNotification(settings,`⚠️ Nikki 在用线路低分\n${server.name} · ${route.family==='ipv4'?'IPv4':'IPv6'}：${estimate.score}/100\n连续至少 5 分钟低于 60 分，当前 ${route.connections} 条连接。\n仅提醒，请根据实际体验决定是否换线。\nhttps://monitor.bjhaha.cc`,{title:'Nikki 在用线路低分'});
        if(!notification_error)state.alerted=1;
      } else notification_error='未配置通知渠道，页面显示提醒';
    }
    // 界面使用本次同源评分依据，避免浏览器采样窗口与后台告警分数不一致。
    const publicEstimate={...estimate,probe:estimate.probe?{taskName:estimate.probe.taskName,lastValue:estimate.probe.lastValue,loss:estimate.probe.loss}:undefined};
    evaluated.push({...route,selected:version===2 && route.selected?1:0,score:estimate.score,reason:estimate.reason,estimate:JSON.stringify(publicEstimate),...state,notification_error});
  }
  // D1 batch 是事务：版本与路线一起发布，评分期间仍可读取上次完整快照。
  // 并发旧报告不得覆盖更新的版本、路线或清理结果。
  const statements=[...evaluated.map(r=>env.DB.prepare(`INSERT INTO nikki_routes (server_id,family,observed_at,connections,score,reason,estimate,low_since,alerted,evaluated_at,notification_error,selected)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM servers WHERE id=?) AND COALESCE((SELECT observed_at FROM nikki_monitor WHERE id=1),0)<?
    ON CONFLICT(server_id,family) DO UPDATE SET observed_at=excluded.observed_at,connections=excluded.connections,score=excluded.score,reason=excluded.reason,estimate=excluded.estimate,low_since=excluded.low_since,alerted=excluded.alerted,evaluated_at=excluded.evaluated_at,notification_error=excluded.notification_error,selected=excluded.selected`)
    .bind(r.server_id,r.family,body.observed_at,r.connections,r.score,r.reason,r.estimate,r.low_since,r.alerted,now,r.notification_error,r.selected,r.server_id,body.observed_at))];
  statements.push(env.DB.prepare('DELETE FROM nikki_routes WHERE observed_at<? AND COALESCE((SELECT observed_at FROM nikki_monitor WHERE id=1),0)<?').bind(body.observed_at,body.observed_at));
  statements.push(env.DB.prepare(`INSERT INTO nikki_monitor VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,unknown_count=excluded.unknown_count WHERE excluded.observed_at>nikki_monitor.observed_at`).bind(body.observed_at,body.unknown_count));
  const committed=await env.DB.batch(statements);
  if(!committed.at(-1).meta.changes)return ok({success:true,replayed:true});
  console.log('[Nikki] report',JSON.stringify({observed_at:body.observed_at,routes:evaluated.length,active:evaluated.filter(r=>r.connections>0).length,selected:evaluated.filter(r=>r.selected).length,unknown:body.unknown_count,alerts:evaluated.filter(r=>r.fire).length}));
  return ok({success:true,routes:evaluated.length,notifications_configured:settings.notification_webhook_enabled==='true' || !!settings.tg_bot_token});
}
export async function handleNikkiStatus(request,env,sys) {
  if(sys.is_public!=='true' && !await checkAuth(request,env,sys))return denied();
  await ensureNikkiTables(env.DB);
  const [metadata,snapshot]=await env.DB.batch([
    env.DB.prepare('SELECT * FROM nikki_monitor WHERE id=1'),
    env.DB.prepare(`SELECT r.* FROM nikki_routes r JOIN servers s ON s.id=r.server_id WHERE r.observed_at=(SELECT observed_at FROM nikki_monitor WHERE id=1) AND COALESCE(s.is_hidden,0) NOT IN (1,'1')`)
  ]);
  const meta=metadata.results?.[0];
  const fresh=!!meta && Date.now()-meta.observed_at<=POLICY.stale_ms;
  // 仅输出节点和地址族，不暴露访问域名、客户端、策略组或代理凭据；隐藏节点仍受站点权限约束。
  const rows=fresh?snapshot.results||[]:[];
  return ok({observed_at:meta?.observed_at||null,fresh,policy:POLICY,routes:rows.map(({server_id,family,score,reason,estimate,low_since,alerted,notification_error,evaluated_at,connections,selected})=>({server_id,family,score,reason,estimate:JSON.parse(estimate||'null'),low_since,alerted:!!alerted,active:connections>0,selected:!!selected,notification_error,evaluated_at}))},{'Cache-Control':'no-store'});
}
