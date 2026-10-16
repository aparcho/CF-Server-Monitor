#!/usr/bin/env python3
"""deb 公网低流量网络监测。仅使用 Python 标准库及已有 ping/iperf3/ssh。"""
import argparse
import concurrent.futures
import contextlib
import datetime as dt
import fcntl
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import sqlite3
import statistics
import subprocess
import sys
import time
import uuid
import urllib.request

TZ = dt.timezone(dt.timedelta(hours=8))
DEFAULT_CONFIG = '/etc/cfsm-netwatch/config.json'
SHARED_LOCK = '/run/lock/cfsm-iperf-shared.lock'
ENV = {**os.environ, 'LC_ALL': 'C'}
for _key in list(ENV):
    if _key.lower().endswith('_proxy'):
        ENV.pop(_key, None)

# 远端助手只有短期监听和自身清理能力；不执行任何防火墙/路由命令。
REMOTE = r'''
import json,os,pathlib,signal,subprocess,sys,time
x=json.loads(sys.argv[1]); token=x['token']; port=x['port']
assert len(token)==32 and all(c in '0123456789abcdef' for c in token) and port==5202
root=pathlib.Path('/tmp')/('cfsm-netwatch-'+str(os.getuid()))
root.mkdir(mode=0o700,exist_ok=True)
p=root/(token+'.json'); log=root/(token+'.log')
def listeners(port):
 return subprocess.check_output(['ss','-ltnp','( sport = :%s )'%port],text=True).strip()
def stamp(pid):
 return pathlib.Path('/proc/%s/stat'%pid).read_text().split(') ',1)[1].split()[19]
if x['action']=='start':
 if len(listeners(port).splitlines())>1: raise RuntimeError('port busy; no existing process touched')
 before=listeners(5201)
 with log.open('w') as f:
  proc=subprocess.Popen(['timeout','-k','2','25','iperf3','-s','-1','-J','-i','1','-p',str(port)],stdout=f,stderr=f,start_new_session=True)
 data={'pid':proc.pid,'stamp':stamp(proc.pid),'before':before}
 p.write_text(json.dumps(data)); p.chmod(0o600)
 time.sleep(.3)
 if proc.poll() is not None: raise RuntimeError('temporary listener failed')
 print(json.dumps({'ready':True}))
else:
 if not p.exists():
  if len(listeners(port).splitlines())>1: raise RuntimeError('ownership record absent; occupied port left untouched')
  print(json.dumps({'cleaned':True,'not_created_or_already_absent':True,'port_closed':True,'port_5201_unchanged':None}))
  sys.exit(0)
 data=json.loads(p.read_text()); pid=data['pid']
 try:
  if stamp(pid)==data['stamp']:
   command=pathlib.Path('/proc/%s/cmdline'%pid).read_bytes()
   if b'iperf3' not in command or b'5202' not in command: raise RuntimeError('listener PID ownership changed')
   os.killpg(pid,signal.SIGTERM)
 except FileNotFoundError: pass
 for _ in range(20):
  if len(listeners(port).splitlines())<=1: break
  time.sleep(.1)
 if len(listeners(port).splitlines())>1: raise RuntimeError('port 5202 remains occupied')
 if listeners(5201)!=data['before']: raise RuntimeError('pre-existing 5201 listener changed')
 server_output=log.read_text()[-24000:] if log.exists() else ''
 p.unlink(); log.unlink(missing_ok=True)
 print(json.dumps({'cleaned':True,'port_closed':True,'port_5201_unchanged':True,'server_output':server_output}))
'''


def run(command, timeout=10, **kwargs):
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout, env=ENV, **kwargs)


def validate(config):
    names = set()
    if not config.get('nodes'):
        raise ValueError('nodes is empty')
    for node in config['nodes']:
        if not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', node['name']) or node['name'] in names:
            raise ValueError('invalid or duplicate node name')
        names.add(node['name'])
        for family in (4, 6):
            address = node.get(f'ipv{family}')
            if address and (not ipaddress.ip_address(address).is_global or ipaddress.ip_address(address).version != family):
                raise ValueError('measurement address must be public and match family')
        if node.get('iperf_enabled'):
            if not re.fullmatch(r'(root|ubuntu)@[a-zA-Z0-9.-]+', node['management_host']):
                raise ValueError('invalid management host')
            if node.get('identity_file') and not re.fullmatch(r'/root/\.ssh/cfsm_iperf_[a-z0-9_-]+', node['identity_file']):
                raise ValueError('invalid identity file')
        if not 1 <= int(node.get('tcp_port', 443)) <= 65535:
            raise ValueError('invalid tcp port')
        if not 1 <= node.get('daily_budget_mib', 512) <= 10240:
            raise ValueError('invalid daily budget')
    defaults = {'quality_interval': 60, 'speed_interval': 300, 'alert_interval': 120,
                'sentinel_bytes': 65536, 'sentinel_bps': 2000000,
                'confirm_bytes': 4194304, 'confirm_bps': 20000000,
                'probe_timeout': 15, 'retention_days': 30, 'global_budget_mib': 2048,
                'loss_alert_percent': 20, 'slow_ratio': .65, 'confirm_cooldown': 3600,
                'retrans_per_mib':100, 'retrans_minimum':10, 'latency_multiplier':2, 'latency_delta_ms':50}
    for key, value in defaults.items():
        config.setdefault(key, value)
    if not (30 <= config['quality_interval'] <= 3600 and 120 <= config['speed_interval'] <= 86400
            and 60 <= config['alert_interval'] <= config['speed_interval']
            and 5 <= config['probe_timeout'] <= 18
            and 1 <= config['global_budget_mib'] <= 102400
            and 1 <= config['retention_days'] <= 365
            and 0 < config['slow_ratio'] < 1
            and 0 < config['loss_alert_percent'] <= 100
            and config['confirm_cooldown'] >= 600
            and 1.1 <= config['latency_multiplier'] <= 10
            and 1 <= config['latency_delta_ms'] <= 10000
            and 1 <= config['retrans_minimum'] <= 100000
            and 0 < config['retrans_per_mib'] <= 1000000):
        raise ValueError('unsafe monitoring intervals or thresholds')
    for kind in ('sentinel', 'confirm'):
        if not (8192 <= config[kind+'_bytes'] <= 16*1024*1024 and 100000 <= config[kind+'_bps'] <= 50000000):
            raise ValueError('unsafe byte or rate limit')
    return config


def connect(config, readonly=False):
    path = Path(config['data_dir']) / 'monitor.sqlite3'
    if readonly:
        db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    else:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        db = sqlite3.connect(path)
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY,ts REAL,node TEXT,family INTEGER,
          direction TEXT,kind TEXT,status TEXT,data TEXT);
        CREATE INDEX IF NOT EXISTS samples_lookup ON samples(node,family,kind,ts);
        CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,day TEXT,node TEXT,
          reserved INTEGER,payload INTEGER DEFAULT 0,status TEXT);
        CREATE INDEX IF NOT EXISTS budget_day ON reservations(day,node);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,ts REAL,node TEXT,family INTEGER,
          category TEXT,message TEXT);
        CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT);
        ''')
    db.row_factory = sqlite3.Row
    return db


def state(db, key, default=None):
    row = db.execute('SELECT value FROM state WHERE key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else default


def set_state(db, key, value):
    db.execute('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
               (key, json.dumps(value)))
    db.commit()


def event(db, node, family, category, message):
    db.execute('INSERT INTO events(ts,node,family,category,message) VALUES (?,?,?,?,?)',
               (time.time(), node, family, category, message))
    db.commit()
    print(json.dumps({'time': dt.datetime.now(TZ).isoformat(), 'node': node, 'family': family,
                      'event': category, 'message': message}, ensure_ascii=False), flush=True)


def save(db, node, family, direction, kind, status, data):
    db.execute('INSERT INTO samples(ts,node,family,direction,kind,status,data) VALUES (?,?,?,?,?,?,?)',
               (time.time(), node, family, direction, kind, status, json.dumps(data)))
    db.commit()


def reserve(db, config, node, amount):
    # 事务在执行网络操作前提交；进程崩溃也不会把未确认的传输额度退回。
    day = dt.datetime.now(TZ).date().isoformat()
    db.execute('BEGIN IMMEDIATE')
    total, own = db.execute('SELECT COALESCE(SUM(reserved),0),COALESCE(SUM(CASE WHEN node=? THEN reserved ELSE 0 END),0) FROM reservations WHERE day=?', (node['name'], day)).fetchone()
    if total + amount > config['global_budget_mib']*1048576 or own + amount > node.get('daily_budget_mib',512)*1048576:
        db.rollback()
        return None
    key = uuid.uuid4().hex
    db.execute('INSERT INTO reservations(id,day,node,reserved,status) VALUES (?,?,?,?,?)',
               (key, day, node['name'], amount, 'reserved'))
    db.commit()
    return key


def route_ok(config, address):
    family = ipaddress.ip_address(address).version
    p = run(['ip', f'-{family}', 'route', 'get', address])
    fields = p.stdout.split()
    expected = config['gateway_ipv'+str(family)]
    return (p.returncode == 0 and 'via' in fields and fields[fields.index('via')+1] == expected
            and 'dev' in fields and fields[fields.index('dev')+1] == config.get('interface','eth0'))


def quality(config, node, family):
    address = node[f'ipv{family}']
    if not route_ok(config, address):
        return 'route_blocked', {'error': '出口网关与配置不符；未发起公网探测'}
    ping = run(['ping', f'-{family}', '-n', '-c', '3', '-i', '.3', '-W', '1', '-w', '4', address], timeout=6)
    samples = [float(x) for x in re.findall(r'time[=<]([0-9.]+)\s*ms', ping.stdout)]
    sent = re.search(r'(\d+) packets transmitted', ping.stdout)
    received = re.search(r'(\d+) received', ping.stdout)
    count = int(sent[1]) if sent else 0
    replies = int(received[1]) if received else 0
    error = None
    started = time.monotonic()
    try:
        with socket.socket(socket.AF_INET if family==4 else socket.AF_INET6, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            sock.connect((address, node.get('tcp_port',443)))
        tcp = round((time.monotonic()-started)*1000,2)
    except OSError as exc:
        tcp, error = None, type(exc).__name__
    return ('ok' if tcp is not None else 'tcp_failed'), dict(
        ping_sent=count, ping_received=replies, ping_ms=samples,
        ping_loss_percent=round((count-replies)*100/count,2) if count else None,
        tcp_ms=tcp, tcp_port=node.get('tcp_port',443), error=error,
        ping_error=ping.stderr[:150] if ping.returncode not in (0,1) else None)


def remote(node, action, token):
    payload = json.dumps({'action':action, 'token':token, 'port':5202})
    command = ['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5','-o','ConnectionAttempts=1',
               '-o','ServerAliveInterval=3','-o','ServerAliveCountMax=1']
    if node.get('identity_file'):
        command += ['-o','IdentitiesOnly=yes','-i',node['identity_file']]
    p = run(command+[node['management_host'], 'python3 -c '+shlex.quote(REMOTE)+' '+shlex.quote(payload)], timeout=12)
    if p.returncode:
        raise RuntimeError((p.stderr or p.stdout)[-400:].strip())
    return json.loads(p.stdout)


def parse_iperf(data, direction):
    if data.get('error'):
        raise ValueError(data['error'])
    end = data['end']
    # 统一采用接收端吞吐；下载重传从服务端发送流取得。
    sender = end.get('sum_sent', {})
    if direction == 'download':
        sender = data.get('server_output_json', {}).get('end', {}).get('sum_sent', {})
    receiver = end['sum_received']
    mbps = receiver['bits_per_second']/1e6
    if not math.isfinite(mbps) or mbps < 0:
        raise ValueError('invalid throughput')
    retries = sender.get('retransmits')
    intervals = data.get('server_output_json',{}).get('intervals',[]) if direction=='download' else data.get('intervals',[])
    rtts = [stream['rtt']/1000 for interval in intervals for stream in interval.get('streams',[]) if stream.get('rtt') is not None]
    return dict(mbps=round(mbps,3), retransmits=retries,
                payload_bytes=max(receiver.get('bytes',0),end.get('sum_sent',{}).get('bytes',0)),
                seconds=receiver.get('seconds'), tcp_rtt_ms=statistics.median(rtts) if rtts else None)


def runner_active():
    p=run(['systemctl','show','cfsm-iperf-runner.service','--property=ActiveState','--value'],timeout=3)
    return p.returncode != 0 or p.stdout.strip() not in ('inactive','failed')


@contextlib.contextmanager
def measurement_lock(config):
    with open(config.get('shared_lock',SHARED_LOCK),'a') as lock:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield not runner_active()
        finally:
            fcntl.flock(lock,fcntl.LOCK_UN)


def speed(db, config, node, family, direction, kind='sentinel'):
    if not node.get('iperf_enabled'):
        return False
    if not route_ok(config,node[f'ipv{family}']):
        event(db,node['name'],family,'route_blocked','出口变化，暂停主动测速；不自动改路由')
        return False
    with measurement_lock(config) as acquired:
        if not acquired:
            return False
        amount=config[kind+'_bytes']
        # iperf 的字节终止按周期检查，先预留整个超时窗口的最大限速载荷。
        reserved=amount+math.ceil(config[kind+'_bps']/8*(config['probe_timeout']+3))+65536
        reservation=reserve(db,config,node,reserved)
        if not reservation:
            key='budget_notice:'+node['name']
            day=dt.datetime.now(TZ).date().isoformat()
            if state(db,key)!=day:
                event(db,node['name'],family,'budget_exhausted','今日主动测速预算不足；Ping/TCP 检测继续')
                set_state(db,key,day)
            return False
        token=uuid.uuid4().hex
        folder=Path(config['data_dir'])/'raw'/dt.datetime.now(TZ).strftime('%Y-%m-%d')
        folder.mkdir(parents=True,exist_ok=True,mode=0o700)
        prefix=folder/(node['name']+f'-v{family}-{direction}-'+token)
        started=False; result={}; status='failed'; cleanup=None
        try:
            # 即使启动 ACK 丢失，finally 仍以本次 token 尝试清理。
            started=True
            remote(node,'start',token)
            command=['iperf3',f'-{family}','-c',node[f'ipv{family}'],'-p','5202',
                     '-J','-i','1','--get-server-output','--connect-timeout','2500',
                     '-n',str(amount),'-b',str(config[kind+'_bps']),'-l','8192']
            if direction=='download': command += ['-R','--rcv-timeout','6000']
            else: command += ['--snd-timeout','6000']
            p=run(command,timeout=config['probe_timeout'])
            Path(str(prefix)+'.json').write_text(p.stdout)
            Path(str(prefix)+'.stderr').write_text(p.stderr)
            if not p.stdout.strip():
                raise ValueError((p.stderr or 'iperf3 returned empty output')[:300])
            data=json.loads(p.stdout)
            result=parse_iperf(data,direction)
            if p.returncode: raise ValueError(data.get('error') or 'iperf3 failed')
            status='ok'
        except subprocess.TimeoutExpired as exc:
            Path(str(prefix)+'.json').write_bytes(exc.stdout or b'')
            Path(str(prefix)+'.stderr').write_bytes(exc.stderr or b'')
            result={'error':'探测超时；已发送字节未知，保留本次全部预算'}
            status='timeout'
        except Exception as exc:
            result={'error':str(exc)[-400:]}
        finally:
            if started:
                try:
                    cleanup=remote(node,'stop',token)
                    server_output=cleanup.pop('server_output',None)
                    if server_output is not None:
                        Path(str(prefix)+'.server.json').write_text(server_output)
                except Exception as exc:
                    cleanup={'error':str(exc)[-400:]}
                    # 启动前端口占用/SSH 失败不表示本任务创建了服务。
                    event(db,node['name'],family,'cleanup_check',cleanup['error'])
        result.update(reservation_id=reservation,target_bps=config[kind+'_bps'],byte_limit=amount,raw=str(prefix),cleanup=cleanup)
        save(db,node['name'],family,direction,kind,status,result)
        payload=result.get('payload_bytes',0)
        # 仅完整 JSON 成功时释放未使用预留；未知失败量绝不当作 0 流量退回。
        charged=payload+65536 if status=='ok' else reserved
        db.execute('UPDATE reservations SET payload=?,status=?,reserved=? WHERE id=?',
                   (payload,status,charged,reservation)); db.commit()
        if charged>reserved:
            event(db,node['name'],family,'budget_overrun','实测字节超过预留，停止该节点主动测速')
            set_state(db,'paused:'+node['name'],'实际载荷超过预算预留')
        key=f"speed:{node['name']}:{family}:{direction}"
        old=state(db,key,{})
        retry_count=result.get('retransmits') or 0
        retry_bad=retry_count>=config['retrans_minimum'] and retry_count/max(payload/1048576,.01)>config['retrans_per_mib']
        weak=status!='ok' or result.get('mbps',0)<config[kind+'_bps']/1e6*config['slow_ratio'] or retry_bad
        streak=old.get('weak_streak',0)+1 if weak else 0
        old.update(last=time.time(),weak_streak=streak,last_status=status)
        if kind=='confirm':
            old.update(confirm_at=time.time(),confirm_pending=False)
        elif streak>=2 and time.time()-old.get('confirm_at',0)>=config['confirm_cooldown']:
            old['confirm_pending']=True
        set_state(db,key,old)
        if weak:
            event(db,node['name'],family,'speed_warning',f"{direction}: {result.get('mbps','不可测')} Mbps，目标 {config[kind+'_bps']/1e6:g} Mbps；{kind} 连续异常 {streak} 次，TCP 重传 {result.get('retransmits','未知')}")
        elif streak==0 and old.get('was_weak'):
            event(db,node['name'],family,'speed_recovered',direction+' 探测恢复')
        old['was_weak']=weak; set_state(db,key,old)
        if cleanup and cleanup.get('error') and status=='ok':
            # 清理异常时不继续开新监听，留待人工/自动超时检查。
            set_state(db,'paused:'+node['name'],cleanup['error'])
        print(json.dumps({'node':node['name'],'family':family,'direction':direction,
                          'kind':kind,'status':status,**result},ensure_ascii=False),flush=True)
        return True


def quality_cycle(db,config):
    work=[(n,f) for n in config['nodes'] for f in (4,6) if n.get(f'ipv{f}') and n.get('watch_enabled',True)]
    def perform(item):
        n,f=item
        try: return n,f,*quality(config,n,f)
        except Exception as exc: return n,f,'error',{'error':str(exc)[:200]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for node,family,status,data in pool.map(perform,work):
            name=node['name']; save(db,name,family,'both','quality',status,data)
            key=f'quality:{name}:{family}'; old=state(db,key,{})
            fail=old.get('tcp_fail_streak',0)+1 if status=='tcp_failed' else 0
            if fail==2 or status=='route_blocked' and old.get('status')!=status:
                event(db,name,family,'reachability',f'TCP 连续失败 {fail} 次' if fail else data['error'])
            if old.get('tcp_fail_streak',0)>=2 and status=='ok':
                event(db,name,family,'recovered','TCP 连通性恢复')
            recent=db.execute("SELECT data FROM samples WHERE node=? AND family=? AND kind='quality' AND ts>? ORDER BY ts DESC",(name,family,time.time()-900)).fetchall()
            values=[json.loads(r[0]) for r in recent]
            sent=sum(v.get('ping_sent',0) for v in values)
            got=sum(v.get('ping_received',0) for v in values)
            loss=100*(sent-got)/sent if sent else None
            loss_bad=sent>=12 and loss>=config['loss_alert_percent']
            if loss_bad and not old.get('loss_bad'):
                event(db,name,family,'icmp_loss',f'近15分钟 ICMP 未响应率 {loss:.1f}%（{sent} 次）；不等同 TCP 丢包')
            rtts=[x for v in values[1:] for x in v.get('ping_ms',[])]
            current=data.get('ping_ms',[])
            base=statistics.median(rtts) if len(rtts)>=12 else None
            delayed=bool(base and current and statistics.median(current)>max(base*config['latency_multiplier'],base+config['latency_delta_ms']))
            delay_streak=old.get('delay_streak',0)+1 if delayed else 0
            if delay_streak==2:
                event(db,name,family,'latency_warning',f'Ping 连续升高，窗口基线 {base:.1f} ms')
            set_state(db,key,{'tcp_fail_streak':fail,'status':status,'loss_bad':loss_bad,'delay_streak':delay_streak})
    set_state(db,'last_quality',time.time())


def prune(db,config):
    cutoff=time.time()-config['retention_days']*86400
    db.execute('DELETE FROM samples WHERE ts<?',(cutoff,))
    db.execute('DELETE FROM events WHERE ts<?',(cutoff,))
    db.execute('DELETE FROM reservations WHERE day<?',(dt.datetime.fromtimestamp(cutoff,TZ).date().isoformat(),))
    db.commit()
    raw=Path(config['data_dir'])/'raw'
    # 仅清理本工具自建的日期目录内原始文件。
    for directory in raw.glob('????-??-??'):
        if directory.is_dir() and directory.name<dt.datetime.fromtimestamp(cutoff,TZ).date().isoformat():
            for p in directory.iterdir():
                if p.is_file() and not p.is_symlink(): p.unlink()
            try: directory.rmdir()
            except OSError: pass


def sync_monitor(db,config):
    if not config.get('worker_url'):
        return
    instance=state(db,'upload_instance')
    if not instance:
        instance=uuid.uuid4().hex;set_state(db,'upload_instance',instance)
    cursor=state(db,'upload_cursor',0)
    batch=db.execute('SELECT * FROM samples WHERE id>? ORDER BY id LIMIT 80',(cursor,)).fetchall()
    by_name={n['name']:n for n in config['nodes']}
    samples=[]
    for row in batch:
        node=by_name.get(row['node'])
        if not node or not node.get('id'):continue
        data=json.loads(row['data'])
        safe={k:data[k] for k in ('ping_sent','ping_received','ping_ms','tcp_ms','tcp_port','mbps','retransmits','target_bps','payload_bytes','seconds','tcp_rtt_ms') if k in data}
        if data.get('cleanup'):safe['cleanup']={k:data['cleanup'].get(k) for k in ('cleaned','port_closed')}
        samples.append(dict(id=instance+':'+str(row['id']),server_id=node['id'],tested_at=round(row['ts']*1000),
                            family='ipv'+str(row['family']),direction=row['direction'],kind=row['kind'],status=row['status'],data=safe))
    day=dt.datetime.now(TZ).date().isoformat();nodes=[]
    for n in config['nodes']:
        reserved,payload=db.execute('SELECT COALESCE(SUM(reserved),0),COALESCE(SUM(payload),0) FROM reservations WHERE day=? AND node=?',(day,n['name'])).fetchone()
        nodes.append(dict(server_id=n['id'],enabled=n.get('watch_enabled',True),iperf_capable=n.get('iperf_enabled',False),
                          reason=n.get('disabled_reason',''),daily_budget_mib=n.get('daily_budget_mib',512),
                          payload_bytes=payload,reserved_bytes=reserved,budget_day=day))
    token=Path(config.get('token_file','/root/.config/cfsm/iperf-token')).read_text().strip()
    req=urllib.request.Request(config['worker_url'].rstrip('/')+'/api/netwatch/report',
        data=json.dumps({'samples':samples,'nodes':nodes}).encode(),
        headers={'Content-Type':'application/json','X-Iperf-Token':token,'User-Agent':'CFSM-Netwatch/1.0'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=8) as response:
        ack=json.load(response)
    if ack.get('success') is not True or ack.get('accepted')!=len(samples):
        raise ValueError('monitor upload acknowledgement mismatch')
    if batch:set_state(db,'upload_cursor',batch[-1]['id'])
    settings={r['server_id']:r for r in ack.get('settings',[])}
    changed=False
    for node in config['nodes']:
        setting=settings.get(node.get('id'))
        if not setting:continue
        update={'watch_enabled':bool(setting['enabled']),'speed_interval':setting['interval_seconds'],
                'daily_budget_mib':setting['daily_budget_mib']}
        for key,value in update.items():
            if node.get(key)!=value:node[key]=value;changed=True
    if changed and config.get('config_path'):
        path=Path(config['config_path']);temporary=path.with_suffix('.monitor.tmp')
        temporary.write_text(json.dumps({k:v for k,v in config.items() if k!='config_path'},ensure_ascii=False,indent=2))
        temporary.chmod(0o600);temporary.replace(path)
        event(db,'deb',0,'monitor_config_applied','已应用 monitor 后台的逐台启停、频率与预算；iperf 防火墙能力不变')
    set_state(db,'last_upload',time.time())


def daemon(config,once=False,quality_only=False):
    if socket.gethostname()!='deb':
        raise RuntimeError('监测必须运行在 deb')
    db=connect(config)
    lock_path=Path(config['data_dir'])/'daemon.lock'
    with lock_path.open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        event(db,'deb',0,'started','启动监控；只校验路由，不修改路由或防火墙')
        last_prune=0
        last_sync=0
        while True:
            now=time.time()
            set_state(db,'heartbeat',now)
            if now-state(db,'last_quality',0)>=config['quality_interval']:
                quality_cycle(db,config)
            if now-last_prune>3600:
                prune(db,config); last_prune=now
            if now-last_sync>=60:
                try:sync_monitor(db,config)
                except Exception as exc:
                    event(db,'deb',0,'monitor_upload_failed',type(exc).__name__+'；本地结果保留，稍后补传')
                last_sync=now
            did=False
            if not quality_only:
                paths=[]
                for n in config['nodes']:
                    if not n.get('watch_enabled',True) or not n.get('iperf_enabled') or state(db,'paused:'+n['name']): continue
                    for f in (4,6):
                        if not n.get(f'ipv{f}'): continue
                        for direction in ('download','upload'):
                            item=state(db,f"speed:{n['name']}:{f}:{direction}",{})
                            health=state(db,f"quality:{n['name']}:{f}",{})
                            quality_bad=health.get('loss_bad') or health.get('tcp_fail_streak',0)>=2 or health.get('delay_streak',0)>=2
                            interval=config['alert_interval'] if item.get('weak_streak',0) or quality_bad else n.get('speed_interval',config['speed_interval'])
                            if item.get('confirm_pending'):
                                paths.append((item.get('last',0),n,f,direction,'confirm'))
                            elif now-item.get('last',0)>=interval:
                                paths.append((item.get('last',0),n,f,direction,'sentinel'))
                paths.sort(key=lambda p:(p[0],p[1]['name'],p[2],p[3]))
                for _,n,f,d,kind in paths:
                    if speed(db,config,n,f,d,kind):
                        did=True
                        break
            if once: break
            time.sleep(2 if did else 5)


def percentile(values,p):
    if not values: return None
    ordered=sorted(values); return ordered[min(len(ordered)-1,math.ceil(p*len(ordered))-1)]


def fmt(value,unit='',digits=1):
    return '—' if value is None else f'{value:.{digits}f}{unit}'


def rows_for(db,node,family,kind,hours=24):
    return db.execute('SELECT * FROM samples WHERE node=? AND family=? AND kind=? AND ts>? ORDER BY ts DESC',
                      (node,family,kind,time.time()-hours*3600)).fetchall()


def trend(db,node,family,direction):
    rows=db.execute("SELECT status,data FROM samples WHERE node=? AND family=? AND direction=? AND kind='sentinel' AND status!='tool_error' ORDER BY ts DESC LIMIT 8",(node,family,direction)).fetchall()
    chars='▁▂▃▄▅▆▇█'
    return ''.join(chars[min(7,max(0,int(json.loads(r['data']).get('mbps',0)/(json.loads(r['data'])['target_bps']/1e6)*7)))] if r['status']=='ok' else '×' for r in reversed(rows)) or '—'


def speed_text(row):
    if row is None: return '—'
    data=json.loads(row['data'])
    if row['status']!='ok': return '失败'
    value=data['mbps']; target=data['target_bps']/1e6
    text=f'≈{target:g}' if value>=target*.9 else f'{value:.2f}'
    age=int((time.time()-row['ts'])/60)
    return f"{text}({data.get('retransmits') if data.get('retransmits') is not None else '—'})/{age}分"


def references(config):
    folder=Path(config.get('existing_results','/root/cfsm-iperf-results'))
    found={}
    for file in sorted(folder.glob('*/summary.json'),reverse=True)[:100]:
        try: rows=json.loads(file.read_text())
        except (OSError,ValueError): continue
        for row in rows:
            key=(row.get('server_id'),row.get('family'),row.get('direction'))
            if row.get('status')=='ok' and (key not in found or row['tested_at']>found[key]['tested_at']):
                found[key]=row
    return found


def status_view(db,config):
    now=time.time(); heartbeat=state(db,'heartbeat',0)
    print('CFSM 公网轻量监控  '+dt.datetime.now(TZ).strftime('%Y-%m-%d %H:%M:%S')+' 北京时间')
    print(f"心跳 {int(now-heartbeat)} 秒前 | Ping/TCP 每 {config['quality_interval']} 秒 | 常规测速约每 {config['speed_interval']//60} 分钟/方向")
    print('速率单位 Mbps；括号为 TCP 重传次数；≈ 为接近限速目标，非最大带宽。')
    print('节点          协议  TCP中位/P95    ICMP未响应  RTT波动    下载(重传)/年龄      上传(重传)/年龄      状态')
    refs=references(config)
    for node in config['nodes']:
        for family in (4,6):
            if not node.get(f'ipv{family}'): continue
            quality_rows=rows_for(db,node['name'],family,'quality',.25)
            values=[json.loads(r['data']) for r in quality_rows]
            tcp=[v['tcp_ms'] for v in values if v.get('tcp_ms') is not None]
            sent=sum(v.get('ping_sent',0) for v in values); got=sum(v.get('ping_received',0) for v in values)
            loss=100*(sent-got)/sent if sent else None
            deltas=[abs(b-a) for v in values for a,b in zip(v.get('ping_ms',[]),v.get('ping_ms',[])[1:])]
            latest={}
            for direction in ('download','upload'):
                latest[direction]=db.execute("SELECT * FROM samples WHERE node=? AND family=? AND direction=? AND kind='sentinel' ORDER BY ts DESC LIMIT 1",(node['name'],family,direction)).fetchone()
            health=state(db,f"quality:{node['name']}:{family}",{})
            label='正常' if quality_rows and quality_rows[0]['status']=='ok' else '待检测/异常'
            if health.get('loss_bad'): label='ICMP高未响应'
            if health.get('delay_streak',0)>=2: label='RTT升高'
            if state(db,'paused:'+node['name']): label='清理异常，已暂停测速'
            elif not node.get('iperf_enabled'): label='仅连通性：'+node.get('disabled_reason','测速未启用')
            elif any(state(db,f"speed:{node['name']}:{family}:{d}",{}).get('weak_streak',0) for d in ('download','upload')): label='速度/重传待确认'
            median=statistics.median(tcp) if tcp else None
            print(f"{node['name']:<13} v{family}   {fmt(median)}/{fmt(percentile(tcp,.95),'ms'):<9} {fmt(loss,'%'):<10} {fmt(statistics.mean(deltas) if deltas else None,'ms'):<9} {speed_text(latest['download']):<21}{speed_text(latest['upload']):<21}{label}")
            confirms=[db.execute("SELECT * FROM samples WHERE node=? AND family=? AND direction=? AND kind='confirm' ORDER BY ts DESC LIMIT 1",(node['name'],family,d)).fetchone() for d in ('download','upload')]
            if any(confirms): print(' '*17+'异常确认：下载 '+speed_text(confirms[0])+'；上传 '+speed_text(confirms[1]))
            if node.get('iperf_enabled'): print(' '*17+'趋势：下载 '+trend(db,node['name'],family,'download')+'  上传 '+trend(db,node['name'],family,'upload'))
            reference=[refs.get((node.get('id'),f'ipv{family}',d)) for d in ('download','upload')]
            if any(reference):
                parts=[]
                for name,r in zip(('下载','上传'),reference):
                    if r: parts.append(f"{name} {r['mbps']:.2f}({r.get('retransmits','—')}) @"+dt.datetime.fromtimestamp(r['tested_at']/1000,TZ).strftime('%m-%d %H:%M'))
                print(' '*17+'原测速历史参考：'+'；'.join(parts))
    print('\n流量：以下为应用数据，不含 TCP/IP、SSH、重传；失败保留额度，预算不等于运营商账单。')
    budget_view(db,config)
    print('ICMP 未响应不等同物理丢包；RTT波动为同一 Ping 小批次相邻 RTT 差值均值。')


def budget_view(db,config):
    day=dt.datetime.now(TZ).date().isoformat()
    for n in config['nodes']:
        used,payload=db.execute('SELECT COALESCE(SUM(reserved),0),COALESCE(SUM(payload),0) FROM reservations WHERE day=? AND node=?',(day,n['name'])).fetchone()
        print(f"  {n['name']:<13} 实测载荷 {payload/1048576:.2f} MiB；预留含控制裕量 {used/1048576:.2f} / {n.get('daily_budget_mib',512)} MiB")
    total=db.execute('SELECT COALESCE(SUM(reserved),0) FROM reservations WHERE day=?',(day,)).fetchone()[0]
    print(f"  合计预留 {total/1048576:.2f} / {config['global_budget_mib']} MiB（每日北京时间 00:00 独立计账）")


def main():
    parser=argparse.ArgumentParser(description='deb 公网低流量网络监测')
    parser.add_argument('--config',default=DEFAULT_CONFIG)
    sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('run');p.add_argument('--once',action='store_true');p.add_argument('--quality-only',action='store_true')
    sub.add_parser('check')
    sub.add_parser('status');sub.add_parser('budget')
    p=sub.add_parser('watch');p.add_argument('--refresh',type=int,default=5)
    p=sub.add_parser('events');p.add_argument('--limit',type=int,default=20)
    for name in ('history','compare'):
        p=sub.add_parser(name);p.add_argument('--node');p.add_argument('--hours',type=float,default=24);p.add_argument('--limit',type=int,default=40)
    args=parser.parse_args()
    config=validate(json.loads(Path(args.config).read_text()))
    config['config_path']=str(Path(args.config).resolve())
    if args.command=='check':
        print(json.dumps({'valid':True,'nodes':len(config['nodes']),'iperf_nodes':[n['name'] for n in config['nodes'] if n.get('iperf_enabled')],
                          'excluded':[{'node':n['name'],'reason':n.get('disabled_reason')} for n in config['nodes'] if not n.get('iperf_enabled')]},ensure_ascii=False,indent=2));return
    if args.command=='run':
        signal.signal(signal.SIGTERM,lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        daemon(config,args.once,args.quality_only);return
    if not (Path(config['data_dir'])/'monitor.sqlite3').exists():
        print('监控尚未初始化，请稍后重试或检查 cfsm-netwatch.service');return
    db=connect(config,readonly=True)
    if args.command in ('status','watch'):
        while True:
            if args.command=='watch' and sys.stdout.isatty(): print('\033[2J\033[H',end='')
            status_view(db,config)
            if args.command=='status':break
            time.sleep(max(2,args.refresh))
    elif args.command=='budget':budget_view(db,config)
    elif args.command=='events':
        for r in db.execute('SELECT * FROM events ORDER BY ts DESC LIMIT ?',(max(1,min(args.limit,500)),)):
            print(dt.datetime.fromtimestamp(r['ts'],TZ).strftime('%m-%d %H:%M:%S'),r['node'],f"v{r['family']}",r['category'],r['message'])
    elif args.command=='history':
        for r in db.execute("SELECT * FROM samples WHERE kind!='quality' AND ts>? AND (? IS NULL OR node=?) ORDER BY ts DESC LIMIT ?",(time.time()-args.hours*3600,args.node,args.node,max(1,min(args.limit,1000)))):
            data=json.loads(r['data'])
            print(dt.datetime.fromtimestamp(r['ts'],TZ).strftime('%m-%d %H:%M:%S'),r['node'],f"v{r['family']}",r['direction'],r['kind'],r['status'],fmt(data.get('mbps'),'Mbps'),f"TCP重传 {data.get('retransmits','—')}",data.get('error',''))
    elif args.command=='compare':
        print(f'最近 {args.hours:g} 小时；限速探测比较，仅代表本端点/端口路径，不代表最大带宽排名。')
        for n in config['nodes']:
            if args.node and n['name']!=args.node:continue
            for f in (4,6):
                for d in ('download','upload'):
                    rows=[r for r in rows_for(db,n['name'],f,'sentinel',args.hours) if r['direction']==d]
                    rates=[json.loads(r['data'])['mbps'] for r in rows if r['status']=='ok']
                    retries=[json.loads(r['data']).get('retransmits') for r in rows if r['status']=='ok']
                    retries=[r for r in retries if r is not None]
                    if rows:print(n['name'],f'v{f}',d,f'成功 {len(rates)}/{len(rows)}',f'中位 {fmt(statistics.median(rates) if rates else None)}',f'P10 {fmt(percentile(rates,.1))}',f'TCP重传合计 {sum(retries) if retries else "—"}')


if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:pass
    except Exception as exc:
        print(f'错误：{exc}',file=sys.stderr);sys.exit(1)
