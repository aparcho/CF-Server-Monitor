import { createUnauthorizedResponse } from '../utils/errors.js';

// 旧采集器的退役入口：验证原上报令牌后清理专属表，拒绝恢复持续探测。
export async function handleNetwatchRetired(request, env) {
  if(!env.IPERF_REPORT_TOKEN || request.headers.get('X-Iperf-Token')!==env.IPERF_REPORT_TOKEN)
    return createUnauthorizedResponse();
  await env.DB.batch(['netwatch_samples','netwatch_nodes','netwatch_meta'].map(name=>
    env.DB.prepare(`DROP TABLE IF EXISTS ${name}`)));
  return new Response(JSON.stringify({retired:true,message:'持续探测功能已移除'}),
    {status:410,headers:{'Content-Type':'application/json'}});
}
