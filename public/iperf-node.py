#!/usr/bin/env python3
"""节点测速助手：仅执行 5202 临时监听，不接受任意命令。"""
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit

ROOT = Path('/etc/cfsm-iperf')
STATE = Path('/run/cfsm-iperf')
CONFIG = ROOT / 'node.json'
HELPER = '/usr/local/sbin/cfsm-iperf-node'

def write_json(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data))
    temporary.chmod(0o600)
    temporary.replace(path)

def api(config, payload, bootstrap=False):
    request = urllib.request.Request(config['worker_url'] + ('/api/iperf/bootstrap' if bootstrap else '/api/iperf/node'),
        data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json', 'User-Agent': 'CFSM-Iperf-Node/1.0',
        **({} if bootstrap else {'X-Iperf-Node-Token': config['token']})})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=20) as response:
        return json.load(response)

def unit(job):
    if not re.fullmatch(r'[a-f0-9-]{36}', job):
        raise ValueError('invalid job id')
    return 'cfsm-iperf-' + job

def source_rules(sources, job):
    if not 1 <= len(sources) <= 2:
        raise ValueError('invalid sources')
    parsed = [ipaddress.ip_address(source) for source in sources]
    if any(not address.is_global for address in parsed) or len({address.version for address in parsed}) != len(parsed):
        raise ValueError('one public source per family required')
    rules = [(('iptables' if address.version == 4 else 'ip6tables'),
        ['INPUT', '-p', 'tcp', '--dport', '5202', '-m', 'comment', '--comment', 'CFSM-auto-' + job, '-j', 'DROP']) for address in parsed]
    for source in sources:
        address = ipaddress.ip_address(source)
        if not address.is_global:
            raise ValueError('source must be public')
        binary = 'iptables' if address.version == 4 else 'ip6tables'
        if not shutil.which(binary):
            raise RuntimeError('missing ' + binary)
        rules.append((binary, ['INPUT', '-p', 'tcp', '-s', str(address), '--dport', '5202', '-m', 'comment', '--comment', 'CFSM-auto-' + job, '-j', 'ACCEPT']))
    return rules

def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, capture_output=True, timeout=25, **kwargs)

def stop_unit(job):
    name = unit(job)
    try:
        run(['systemctl', 'stop', name])
    except subprocess.CalledProcessError:
        # systemd --collect 会移除已经结束的临时服务。重复停止应视为完成，
        # 但不能吞掉仍然存在的服务或实际停止错误。
        state = run(['systemctl', 'show', name + '.service', '--property=LoadState', '--property=ActiveState']).stdout
        fields = dict(line.split('=', 1) for line in state.splitlines() if '=' in line)
        if fields.get('LoadState') != 'not-found' or fields.get('ActiveState') != 'inactive':
            raise

def listen(path):
    session = json.loads(Path(path).read_text())
    rules = source_rules(session['sources'], session['job_id'])
    owned, child = [], None
    before = run(['ss', '-ltnp', '( sport = :5201 )']).stdout
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(InterruptedError()))
    try:
        if run(['ss', '-ltn', '( sport = :5202 )']).stdout.strip().count('\n'):
            raise RuntimeError('port 5202 busy')
        for binary, rule in rules:
            run([binary, '-w', '5', '-I', rule[0], '1', *rule[1:]])
            owned.append((binary, rule))
        family = ['-4' if ipaddress.ip_address(session['sources'][0]).version == 4 else '-6'] if len(session['sources']) == 1 else []
        child = subprocess.Popen(['iperf3', '-s', '-p', '5202', *family], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        if child.poll() is not None:
            raise RuntimeError('iperf3 listener failed')
        write_json(Path(path), {**session, 'state': 'ready'})
        child.wait(timeout=580)
    except (InterruptedError, subprocess.TimeoutExpired):
        pass
    except Exception as exc:
        session['error'] = str(exc)[:150]
    finally:
        if child and child.poll() is None:
            child.terminate()
            try: child.wait(timeout=8)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        failures = []
        for binary, rule in reversed(owned):
            try: run([binary, '-w', '5', '-D', *rule])
            except Exception: failures.append('temporary firewall cleanup failed')
        try:
            if run(['ss', '-ltnp', '( sport = :5201 )']).stdout != before:
                failures.append('pre-existing port 5201 listener changed')
            if run(['ss', '-ltn', '( sport = :5202 )']).stdout.strip().count('\n'):
                failures.append('port 5202 remains occupied')
        except Exception: failures.append('listener cleanup verification failed')
        if failures: session['error'] = '; '.join(failures)
        write_json(Path(path), {**session, 'state': 'failed' if session.get('error') else 'stopped'})

def addresses(base):
    result = {}
    for family in (4, 6):
        try:
            text = run(['curl', '-fsS', '--noproxy', '*', f'--ipv{family}', '--connect-timeout', '5', '--max-time', '8', base + '/cdn-cgi/trace']).stdout
            value = next(line[3:] for line in text.splitlines() if line.startswith('ip='))
            address = ipaddress.ip_address(value)
            if address.version == family and address.is_global: result[f'ipv{family}'] = str(address)
        except Exception: pass
    return result

def serve():
    config = json.loads(CONFIG.read_text())
    current, cached_addresses, address_time = None, {}, 0
    while True:
        try:
            if time.time() - address_time > 3600:
                cached_addresses = addresses(config['worker_url']); address_time = time.time()
            payload = {'id': config['id'], **cached_addresses}
            if current:
                path = STATE / (current + '.json')
                if path.exists():
                    state = json.loads(path.read_text())
                    if state.get('state') in ('ready', 'stopped', 'failed'): payload['session'] = state
            command = api(config, payload)
            job = command.get('job_id')
            if command['command'] == 'start':
                unit_name = unit(job)
                path = STATE / (job + '.json')
                if current and current != job:
                    stop_unit(current)
                current = job
                if not path.exists():
                    write_json(path, {**command, 'state': 'starting'})
                    try:
                        run(['systemd-run', '--quiet', '--collect', '--unit=' + unit_name,
                            '--property=RuntimeMaxSec=600', '--property=TimeoutStopSec=15',
                            sys.executable, HELPER, 'listen', str(path)])
                    except Exception as exc:
                        write_json(path, {**command, 'state': 'failed', 'error': str(exc)[:150]})
            elif command['command'] == 'stop':
                current = job
                stop_unit(job)
                path = STATE / (job + '.json')
                if not path.exists(): write_json(path, {**command, 'state': 'stopped'})
            elif command['command'] == 'wait':
                current = job
            elif command['command'] == 'idle' and current:
                path = STATE / (current + '.json')
                if not path.exists() or json.loads(path.read_text()).get('state') in ('stopped', 'failed'):
                    if path.exists(): path.unlink()
                    current = None
        except Exception as exc:
            print('CFSM iperf node: ' + type(exc).__name__ + ': ' + str(exc)[:200], flush=True)
        time.sleep(2 if current else 60)

def install(args):
    values = dict(arg.lstrip('-').split('=', 1) for arg in args if arg.startswith('-') and '=' in arg)
    base = values.get('url', '').rstrip('/')
    if base.endswith('/update'): base = base[:-7]
    url = urlsplit(base)
    if url.scheme != 'https' or not url.hostname or url.username or url.query or url.fragment or url.path:
        raise ValueError('invalid Worker URL')
    if os.geteuid() != 0 or not Path('/run/systemd/system').exists(): raise RuntimeError('root and systemd required')
    config = {'id': values['id'], 'worker_url': base}
    enrolled = api(config, {'id': values['id'], 'secret': values['secret']}, bootstrap=True)
    config['token'] = enrolled['token']
    write_json(CONFIG, config)
    Path('/etc/systemd/system/cfsm-iperf-node.service').write_text('[Unit]\nDescription=CFSM automatic iperf node\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nExecStart=/usr/bin/python3 ' + HELPER + ' serve\nRestart=always\nRestartSec=10\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n')
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'cfsm-iperf-node.service'])
    run(['systemctl', 'restart', 'cfsm-iperf-node.service'])
    print('自动测速助手已安装，deb 将自动检查公网连通性；定时默认关闭。')

if __name__ == '__main__':
    if sys.argv[1] == 'install': install(sys.argv[2:])
    elif sys.argv[1] == 'serve': serve()
    elif sys.argv[1] == 'listen': listen(sys.argv[2])
