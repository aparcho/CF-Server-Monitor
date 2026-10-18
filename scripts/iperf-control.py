"""按任务保存监听回执；SSH 断开后只查询原任务，不重复启动测速。"""
import json,subprocess,time

class Listener:
 def __init__(self,remote,audit,host,identity,job,sources):
  self.remote=remote;self.audit=audit;self.host=host;self.identity=identity;self.job=job;self.sources=sources
 def call(self,script,phase):
  start=time.monotonic();self.audit('listener_control_begin',job_id=self.job,host=self.host,operation=phase)
  try:
   result=self.remote(self.host,('sudo -n sh -s <<\'CFSM_ROOT\'\n'+script+'\nCFSM_ROOT') if self.host.startswith('ubuntu@') else script,timeout=45,identity_file=self.identity)
   self.audit('listener_control_complete',job_id=self.job,operation=phase,elapsed_ms=round((time.monotonic()-start)*1000));return result
  except Exception as exc:
   self.audit('listener_control_error',job_id=self.job,operation=phase,elapsed_ms=round((time.monotonic()-start)*1000),kind=type(exc).__name__,detail=str(exc)[:160]);raise
 def status(self):
  return json.loads(self.call("python3 - <<'PY'\nimport pathlib,json,subprocess\np=pathlib.Path('/run/cfsm-iperf-control/"+self.job+".json');unit='cfsm-iperf-control-"+self.job+".service'\ns=json.loads(p.read_text()) if p.exists() else {'state':'absent'}\nr=subprocess.run(['systemctl','show',unit,'--property=ActiveState','--value'],capture_output=True,text=True);s['unit_active']=r.stdout.strip()=='active'\nprint(json.dumps(s))\nPY",'status'))
 def start(self):
  # 先建立只读控制会话，慢速 Tailnet 握手与监听创建分开记录。
  for attempt in range(2):
   try:
    previous=self.status();break
   except (subprocess.TimeoutExpired,RuntimeError):
    if attempt:raise
    self.audit('listener_preflight_retry',job_id=self.job);time.sleep(2)
  if previous.get('state')=='ready':return
  if previous.get('state')!='absent':raise RuntimeError('task already has terminal or incomplete receipt: '+previous.get('error',previous.get('state','unknown')))
  session={'job_id':self.job,'sources':self.sources,'expires_at':int(time.time()*1000)+600000}
  script="""python3 - <<'PY'
import pathlib,json,subprocess
session=SESSION
root=pathlib.Path('/run/cfsm-iperf-control');root.mkdir(mode=0o700,exist_ok=True)
p=root/(session['job_id']+'.json');unit='cfsm-iperf-control-'+session['job_id']
if not p.exists():
 p.write_text(json.dumps(session));p.chmod(0o600)
 subprocess.run(['systemd-run','--quiet','--collect','--unit='+unit,'--property=RuntimeMaxSec=600','--property=TimeoutStopSec=15','/usr/bin/python3','/opt/cfsm-iperf-control/node.py','listen',str(p)],check=True)
print('requested')
PY""".replace('SESSION',repr(session))
  try:self.call(script,'start')
  except subprocess.TimeoutExpired:self.audit('listener_start_reply_lost',job_id=self.job)
  # 只重读持久回执，绝不在响应丢失后盲目重发 start。
  deadline=time.monotonic()+60
  while True:
   state=self.status();self.audit('listener_receipt',job_id=self.job,state=state.get('state'),unit_active=state.get('unit_active'))
   if state.get('state')=='ready':return
   if state.get('state') in ('failed','stopped','absent'):raise RuntimeError('listener start unconfirmed: '+state.get('error',state.get('state','unknown')))
   if time.monotonic()>deadline:raise TimeoutError('listener readiness receipt timed out')
   time.sleep(2)
 def stop(self):
  # stop 按任务唯一 unit 重入安全；只停止本任务，保留其他原服务。
  script="""python3 - <<'PY'
import pathlib,json,subprocess
job=JOB;unit='cfsm-iperf-control-'+job+'.service';p=pathlib.Path('/run/cfsm-iperf-control/'+job+'.json')
subprocess.run(['systemctl','stop',unit],capture_output=True)
s=json.loads(p.read_text()) if p.exists() else {'state':'absent'}
r=subprocess.run(['systemctl','show',unit,'--property=ActiveState','--value'],capture_output=True,text=True)
if r.stdout.strip()=='active':raise RuntimeError('task listener remains active')
if s.get('state')not in ('stopped','absent'):raise RuntimeError('cleanup receipt: '+s.get('error',s.get('state','unknown')))
for binary in ['iptables-save','ip6tables-save']:
 try:
  if 'CFSM-auto-'+job in subprocess.check_output([binary]).decode():raise RuntimeError('task firewall rule remains')
 except FileNotFoundError:pass
print('cleanup_confirmed')
PY""".replace('JOB',repr(self.job))
  try:self.call(script,'stop')
  except subprocess.TimeoutExpired:
   self.audit('listener_cleanup_reply_lost',job_id=self.job);self.call(script,'stop_reconcile')
