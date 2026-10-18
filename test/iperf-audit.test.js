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

test('空轮询只按15分钟采样写D1，关键事件与错误不采样，控制台保留全部', async t => {
  const {shouldPersistIperfAudit}=await import('../src/utils/iperfAudit.js');
  const off=60_000,on=15*60_000;
  for(const phase of ['claim_empty','targets_refresh_begin','targets_refresh_complete','expiry_refresh_checked']){
    assert.equal(shouldPersistIperfAudit(phase,{},off),false);
    assert.equal(shouldPersistIperfAudit(phase,{},on),true);
  }
  assert.equal(shouldPersistIperfAudit('request_exit',{path:'/api/iperf/jobs/claim',status:200},off),false);
  assert.equal(shouldPersistIperfAudit('request_exit',{path:'/api/iperf/jobs/claim',status:500},off),true);
  for(const phase of ['cron_enter','cron_complete','dispatch_selected','enqueue_result','job_claimed','job_finished','request_error','expiry_refresh_enqueue'])assert.equal(shouldPersistIperfAudit(phase,{},off),true);
  assert.equal(shouldPersistIperfAudit('expiry_refresh_skipped',{reason:'target_not_ready'},off),true);
  const logs=[];t.mock.method(Date,'now',()=>off);t.mock.method(console,'log',line=>logs.push(JSON.parse(line)));
  let touched=false;
  await iperfAudit({prepare(){touched=true;throw new Error('must not touch D1')}},'claim_empty');
  assert.equal(touched,false);assert.equal(logs[0].phase,'claim_empty');assert.equal(logs[0].d1_sampled,true);
});
