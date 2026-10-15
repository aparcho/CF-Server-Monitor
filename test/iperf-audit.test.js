import test from 'node:test';
import assert from 'node:assert/strict';
import { iperfAudit, traceIperfRequest } from '../src/utils/iperfAudit.js';

test('数据库日志写失败仍保留控制台证据，业务响应与异常不被吞掉', async () => {
  const db={prepare(){throw new Error('D1 unavailable')}};
  const logs=[];
  const originalLog=console.log, originalError=console.error;
  console.log=line=>logs.push(JSON.parse(line));
  console.error=line=>logs.push(JSON.parse(line));
  try {
    const response=new Response('ok');
    assert.equal(await traceIperfRequest(db,'/claim',async()=>response),response);
    const failure=new Error('original error');
    await assert.rejects(()=>traceIperfRequest(db,'/claim',async()=>{throw failure}),error=>error===failure);
    assert.ok(logs.some(r=>r.phase==='request_exit'&&r.status===200));
    assert.ok(logs.some(r=>r.phase==='request_error'&&r.error==='original error'));
    assert.ok(logs.some(r=>r.phase==='audit_write_failed'));
    assert.equal(typeof await iperfAudit(db,'test'), 'string');
  } finally {console.log=originalLog;console.error=originalError;}
});
