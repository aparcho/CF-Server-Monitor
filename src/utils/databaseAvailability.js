// 数据库额度耗尽必须显式报错，不能伪装成空站点或默认权限。
export function isDatabaseQuotaError(error) {
  for(let current=error,depth=0;current && depth<5;current=current.cause,depth++) {
    if(/exceeded D1's free tier daily row (?:read|write) limit/i.test(String(current.message||current)))return true;
  }
  return false;
}
export function databaseQuotaResponse(request) {
  const message='数据库当日读取或写入额度已耗尽，服务暂不可用。这不表示服务器记录已删除。免费额度于北京时间每日 08:00 重置。';
  const api=new URL(request.url).pathname.startsWith('/api/') || new URL(request.url).pathname.startsWith('/admin/api') || new URL(request.url).pathname==='/update';
  return new Response(api?JSON.stringify({error:message,code:503,reason:'database_daily_limit'}):`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Monitor 暂不可用</title><body style="font:16px/1.8 system-ui;max-width:700px;margin:12vh auto;padding:24px"><h1>Monitor 暂不可用</h1><p>${message}</p><p>请稍后刷新。无需重新添加节点或初始化数据库。</p></body></html>`,{status:503,headers:{'Content-Type':api?'application/json; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','Retry-After':'60'}});
}
