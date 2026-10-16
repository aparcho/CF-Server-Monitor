import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, reactive } from 'vue';

const require=createRequire(import.meta.url);
const source=await readFile(new URL('../src/frontend/views/admin/components/IperfPanel.vue',import.meta.url),'utf8');
const {descriptor}=parse(source);
const compiled=compileScript(descriptor,{id:'iperf-poll-test'}).content
  .replace("from 'vue'",`from '${pathToFileURL(require.resolve('vue')).href}'`)
  .replace("import NetwatchPanel from './NetwatchPanel.vue'",'const NetwatchPanel = {}')
  .replace("import { adminApi } from '../../../utils/api'",'const adminApi = (...args) => globalThis.__iperfPanelTestApi(...args)');
const {default:Panel}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
Panel.render=()=>null;
const renderer=createRenderer({insert(){},remove(){},createElement(){return {}},createText(){return {}},createComment(){return {}},setText(){},setElementText(){},parentNode(){return null},nextSibling(){return null},patchProp(){}});
const flush=async()=>{for(let i=0;i<8;i++){await Promise.resolve();await nextTick()}};
const data=status=>({data:{jobs:[{id:'job',server_id:'a',status}],schedules:[{server_id:'a',enabled:true,time_beijing:'22:00',time_beijing_day:'11:30',duration_seconds:5}],ready_targets:['a']}});
function mount(){
  const props=reactive({activeTab:'iperf',servers:[],selectedApiIndex:0});
  let instance;
  const app=renderer.createApp({render:()=>h(Panel,{...props,ref:value=>{if(value)instance=value.$}})});
  app.mount({});
  return {props,app,state:()=>instance.setupState};
}

test('每5秒刷新到完成即停止，保留未保存的定时编辑',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0;
  globalThis.__iperfPanelTestApi=async()=>data(['queued','running','completed'][Math.min(calls++,2)]);
  const view=mount();
  try{
    await flush();assert.equal(calls,1);
    view.state().forms.a.time_beijing='20:15';
    t.mock.timers.tick(4999);await flush();assert.equal(calls,1);
    t.mock.timers.tick(1);await flush();assert.equal(calls,2);
    assert.equal(view.state().jobs[0].status,'running');
    assert.equal(view.state().forms.a.time_beijing,'20:15');
    t.mock.timers.tick(5000);await flush();assert.equal(calls,3);
    assert.equal(view.state().jobs[0].status,'completed');
    t.mock.timers.tick(20000);await flush();assert.equal(calls,3);
  }finally{view.app.unmount();delete globalThis.__iperfPanelTestApi}
});

test('切换页面与卸载停止轮询，慢请求不重叠',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0,resolve;
  globalThis.__iperfPanelTestApi=async()=>{calls++;if(calls===2)return new Promise(r=>resolve=r);return data('running')};
  const view=mount();
  try{
    await flush();t.mock.timers.tick(5000);await flush();assert.equal(calls,2);
    t.mock.timers.tick(20000);await flush();assert.equal(calls,2);
    view.props.activeTab='servers';await flush();resolve(data('running'));await flush();
    t.mock.timers.tick(10000);await flush();assert.equal(calls,2);
    view.props.activeTab='iperf';await flush();assert.equal(calls,3);
    view.app.unmount();t.mock.timers.tick(10000);await flush();assert.equal(calls,3);
  }finally{view.app.unmount();delete globalThis.__iperfPanelTestApi}
});


test('最近任务每页5条，翻页不影响后台测速轮询，刷新后收缩页码',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let count=12;
  globalThis.__iperfPanelTestApi=async()=>({data:{jobs:Array.from({length:count},(_,i)=>({id:'job-'+i,server_id:'a',status:i===0?'running':'completed'}))}});
  const view=mount();
  try {
    await flush();assert.equal(view.state().jobPage,1);
    assert.deepEqual(view.state().pagedJobs.map(j=>j.id),['job-0','job-1','job-2','job-3','job-4']);
    assert.equal(view.state().jobPages,3);
    view.state().jobPage=3;await flush();assert.equal(view.state().pagedJobs.length,2);
    t.mock.timers.tick(5000);await flush();
    assert.equal(view.state().jobPage,3);assert.equal(view.state().pagedJobs[0].id,'job-10');
    count=6;t.mock.timers.tick(5000);await flush();
    assert.equal(view.state().jobPage,2);assert.equal(view.state().pagedJobs.length,1);
    view.props.selectedApiIndex=1;await flush();assert.equal(view.state().jobPage,1);
    count=0;await view.state().load();await flush();assert.equal(view.state().jobPages,1);assert.equal(view.state().pagedJobs.length,0);
  } finally {view.app.unmount();delete globalThis.__iperfPanelTestApi}
});
