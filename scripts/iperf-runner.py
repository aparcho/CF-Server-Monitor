#!/usr/bin/env python3
"""Claim CFSM iperf jobs on deb and run only locally allowlisted targets."""
import argparse
import importlib.util
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import socket
import time
import uuid


def audit(phase, **detail):
    entry = {'scope': 'iperf_runner', 'phase': phase, 'observed_at': time.time_ns() // 1_000_000,
             'pid': os.getpid(), **detail}
    line = json.dumps(entry, ensure_ascii=False)
    print(line, flush=True)
    try:
        folder = Path('/root/cfsm-iperf-runner-audit')
        folder.mkdir(mode=0o700, exist_ok=True)
        path = folder / (time.strftime('%Y-%m-%d', time.gmtime()) + '.jsonl')
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), 'a') as log:
            log.write(line + '\n')
        for old in folder.glob('????-??-??.jsonl'):
            if old.stat().st_mtime < time.time() - 14 * 86400:
                old.unlink()
    except OSError as exc:
        print(f'runner audit write failed: {exc}', file=sys.stderr, flush=True)


class ApiFailure(RuntimeError):
    def __init__(self,message,retryable=True):
        super().__init__(message);self.retryable=retryable


def api_once(base, token, path, payload, family='--ipv6', attempt=1):
    started = time.monotonic()
    audit('api_begin', path=path, job_id=payload.get('id'), family=family, attempt=attempt)
    if any(char in token for char in '\r\n"\\'):
        raise ValueError('invalid token format')
    with tempfile.NamedTemporaryFile(mode='w', prefix='.cfsm-curl-', dir='/root/.config/cfsm') as options:
        options.write(f'header = "X-Iperf-Token: {token}"\n')
        options.flush()
        result = subprocess.run(['curl', '--silent', '--show-error', '--fail-with-body', family,
            '--connect-timeout', '10', '--max-time', '30', '--config', options.name,
            '--header', 'Content-Type: application/json', '--header', 'User-Agent: CFSM-Iperf/1.0',
            '--write-out', '\n%{http_code}', '--data-binary', '@-', base.rstrip('/') + path], input=json.dumps(payload),
            text=True, capture_output=True, timeout=35)
    body,_,status=result.stdout.rpartition('\n')
    http_status=int(status) if status.isdigit() else 0
    if result.returncode:
        audit('api_error', path=path, job_id=payload.get('id'), returncode=result.returncode,
              http_status=http_status,family=family,attempt=attempt,
              elapsed_ms=round((time.monotonic() - started) * 1000))
        raise ApiFailure((result.stderr.strip()[:180] or 'Worker request failed')+f' (HTTP {http_status})',
                         http_status in (0,408,429) or http_status>=500)
    try: response=json.loads(body)
    except ValueError: raise ApiFailure(f'Worker returned non-JSON response (HTTP {http_status})') from None
    audit('api_complete', path=path, job_id=payload.get('id'),family=family,attempt=attempt,
          elapsed_ms=round((time.monotonic() - started) * 1000))
    return response


def api(base,token,path,payload):
    for attempt,family in enumerate(('--ipv6','--ipv4','--ipv6'),1):
        try:return api_once(base,token,path,payload,family,attempt)
        except (ApiFailure,subprocess.TimeoutExpired) as exc:
            if attempt==3 or isinstance(exc,ApiFailure) and not exc.retryable:raise
            audit('api_retry',path=path,job_id=payload.get('id'),attempt=attempt)
            time.sleep(attempt)


def write_receipt(path,data):
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    temp=path.with_suffix('.tmp')
    with os.fdopen(os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as stream:
        json.dump(data,stream);stream.flush();os.fsync(stream.fileno())
    temp.replace(path)


def flush_completions(base,token,state_dir):
    for path in sorted((state_dir/'pending-finish').glob('*.json')):
        payload=json.loads(path.read_text())
        response=api(base,token,'/api/iperf/jobs/finish',payload)
        if response.get('success') is not True:raise RuntimeError('completion acknowledgement missing')
        path.unlink();audit('completion_acknowledged',job_id=payload['id'],status=payload['status'])


def claim_job(base,token,state_dir):
    path=state_dir/'claim-request.json'
    if not path.exists():write_receipt(path,{'request_id':str(uuid.uuid4())})
    payload=json.loads(path.read_text())
    job=api(base,token,'/api/iperf/jobs/claim',payload)
    path.unlink()
    if job and job.get('status') not in (None,'running'):
        audit('claim_already_terminal',job_id=job['id'],status=job.get('status'));return None
    return job


def remote(host, script, timeout=20, identity_file=None):
    if not re.fullmatch(r'(?:root|ubuntu)@[a-zA-Z0-9.-]{1,100}', host):
        raise ValueError('invalid management host')
    command = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
    if identity_file is not None:
        if not re.fullmatch(r'/root/\.ssh/cfsm_iperf_[a-z0-9_-]{1,40}', identity_file):
            raise ValueError('invalid identity file')
        command += ['-o', 'IdentitiesOnly=yes', '-i', identity_file]
    result = subprocess.run(command + [host, 'sh', '-s'],
        input=script, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()[:200] or 'remote command failed')
    return result.stdout.strip()


def public_sources(base, families=(4, 6)):
    sources = []
    for family in families:
        result = subprocess.run(['curl', '--silent', '--show-error', '--fail', '--noproxy', '*',
            f'--ipv{family}', '--connect-timeout', '5', '--max-time', '10',
            base.rstrip('/') + '/cdn-cgi/trace'], text=True, capture_output=True, timeout=12)
        if result.returncode:
            raise RuntimeError(f'cannot determine deb public IPv{family} source')
        values = [line[3:] for line in result.stdout.splitlines() if line.startswith('ip=')]
        if len(values) != 1 or ipaddress.ip_address(values[0]).version != family:
            raise ValueError(f'invalid deb public IPv{family} source')
        sources.append(values[0])
    return sources


def worker_listener(base, token, job_id, action, sources=None):
    response = api(base, token, '/api/iperf/listener', {'job_id': job_id, 'action': action, **({'sources': sources} if sources else {})})
    wanted = 'ready' if action == 'start' else 'stopped'
    deadline = time.monotonic() + 100
    while response.get('state') != wanted:
        if response.get('state') == 'failed':
            raise RuntimeError(response.get('error') or 'node listener failed')
        if time.monotonic() > deadline:
            raise TimeoutError('node listener acknowledgement timed out')
        time.sleep(2)
        response = api(base, token, '/api/iperf/listener', {'job_id': job_id, 'action': 'status'})


def check_auto_target(target, output, job_id):
    results = []
    for family in ('ipv4', 'ipv6'):
        if target.get(family):
            address = ipaddress.ip_address(target[family])
            if not address.is_global:
                raise ValueError('onboarding target must use a public address')
            try:
                with socket.create_connection((str(address), 5202), timeout=5):
                    results.append({'family': family, 'status': 'reachable'})
            except OSError:
                results.append({'family': family, 'status': 'no_response'})
    folder = Path(output) / 'onboarding'
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f'{job_id}.json').write_text(json.dumps({'server_id': target['id'], 'results': results}, indent=2))
    if not results or any(row['status'] != 'reachable' for row in results):
        raise RuntimeError('公网 5202 不可达，请检查云防火墙或上游端口映射')


def start_listener(host, identity_file=None, sources=None):
    if sources is not None:
        source_v4, source_v6 = sources
        output = remote(host, f'''set -eu
if systemctl is-active --quiet cfsm-iperf-5202.service; then echo 'test service busy' >&2; exit 2; fi
before=$(ss -ltnp '( sport = :5201 )' | tail -n +2)
systemd-run --quiet --collect --unit=cfsm-iperf-5202 --property=RuntimeMaxSec=620 --property=KillMode=process --property=TimeoutStopSec=30 /usr/local/sbin/cfsm-iperf-ufw-listener {source_v4} {source_v6}
for n in 1 2 3 4 5 6 7 8; do
  if ss -ltn '( sport = :5202 )' | tail -n +2 | grep -q .; then break; fi
  sleep 1
done
if ! ss -ltn '( sport = :5202 )' | tail -n +2 | grep -q .; then
  systemctl stop cfsm-iperf-5202.service || true
  echo 'protected listener failed' >&2; exit 3
fi
pid=$(systemctl show -p MainPID --value cfsm-iperf-5202.service)
printf '%s\\n%s\\n' "$pid" "$before"
''', timeout=35, identity_file=identity_file)
    else:
        output = remote(host, '''set -eu
command -v iperf3 >/dev/null
command -v timeout >/dev/null
if ss -ltn '( sport = :5202 )' | tail -n +2 | grep -q .; then echo 'port 5202 busy' >&2; exit 2; fi
before=$(ss -ltnp '( sport = :5201 )' | tail -n +2)
nohup timeout 600s iperf3 -s -p 5202 >/dev/null 2>&1 </dev/null &
pid=$!
sleep 1
if ! kill -0 "$pid" 2>/dev/null || ! ss -ltn '( sport = :5202 )' | tail -n +2 | grep -q .; then echo 'listener failed' >&2; exit 3; fi
printf '%s\\n%s\\n' "$pid" "$before"
''', identity_file=identity_file)
    parts = output.splitlines()
    if not parts or not parts[0].isdigit():
        raise RuntimeError('remote listener returned no PID')
    return int(parts[0]), '\n'.join(parts[1:])


def stop_listener(host, pid, before, identity_file=None, protected=False):
    if not isinstance(pid, int) or pid < 2:
        raise ValueError('invalid listener PID')
    if protected:
        script = f'''set -eu
pid={pid}
current=$(systemctl show -p MainPID --value cfsm-iperf-5202.service)
if [ "$current" = "$pid" ]; then systemctl stop cfsm-iperf-5202.service; fi
sleep 1
if ss -ltn '( sport = :5202 )' | tail -n +2 | grep -q .; then echo 'port 5202 remains occupied' >&2; exit 4; fi
if ufw status | grep '5202/tcp' | grep -q 'CFSM deb temporary'; then echo 'temporary firewall rule remains' >&2; exit 5; fi
ss -ltnp '( sport = :5201 )' | tail -n +2
'''
    else:
        script = f'''set -eu
pid={pid}
if [ -r "/proc/$pid/cmdline" ] && tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -q 'timeout 600s iperf3 -s -p 5202'; then kill "$pid"; fi
sleep 1
if ss -ltn '( sport = :5202 )' | tail -n +2 | grep -q .; then echo 'port 5202 remains occupied' >&2; exit 4; fi
ss -ltnp '( sport = :5201 )' | tail -n +2
'''
    after = remote(host, script, identity_file=identity_file)
    if after != before:
        raise RuntimeError('pre-existing port 5201 listener changed')


def main():
    audit('runner_enter')
    parser = argparse.ArgumentParser()
    parser.add_argument('config', help='local allowlist JSON with worker_url and targets')
    parser.add_argument('--token-file', default='/root/.config/cfsm/iperf-token')
    parser.add_argument('--output', default='/root/cfsm-iperf-results')
    parser.add_argument('--state-dir',default='/root/cfsm-iperf-state')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    token = Path(args.token_file).read_text().strip()
    if not token:
        raise ValueError('empty token file')
    state_dir=Path(args.state_dir)
    flush_completions(config['worker_url'],token,state_dir)
    refresh = api(config['worker_url'], token, '/api/iperf/targets',
        {'server_ids': [target['id'] for target in config['targets']]})
    deleted = set(refresh.get('deleted_ids', []))
    if deleted:
        config['targets'] = [t for t in config['targets'] if t['id'] not in deleted]
        path = Path(args.config); temporary = path.with_suffix('.reconcile.tmp')
        temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2))
        temporary.chmod(0o600); temporary.replace(path)
        audit('deleted_targets_removed', server_ids=sorted(deleted))
    job = claim_job(config['worker_url'],token,state_dir)
    if not job:
        audit('claim_empty')
        print('no queued job')
        return
    audit('job_claimed', job_id=job['id'], server_id=job['server_id'], source=job.get('source'))
    error = None
    count = 0
    listener = None
    auto_listener = None
    durable_listener = None
    cleanup_ok = True
    target = next((x for x in config['targets'] if x['id'] == job['server_id']), None)
    if target is None or job.get('source') == 'onboarding':
        target = job.get('auto_target')
    try:
        if target is None:
            raise ValueError('target not configured on deb')
        if int(target.get('port', 5202)) != 5202:
            raise ValueError('only isolated port 5202 is supported')
        if target.get('listener_mode') == 'receipt':
            spec=importlib.util.spec_from_file_location('iperf_control',Path(__file__).with_name('iperf-control.py'));control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)
            families=tuple(f for f in (4,6) if target.get(f'ipv{f}'))
            sources=public_sources(config['worker_url'],families)
            durable_listener=control.Listener(remote,audit,target['management_host'],target.get('identity_file'),job['id'],sources)
            durable_listener.start()
        elif target.get('transport') == 'worker':
            families = tuple(f for f in (4, 6) if target.get(f'ipv{f}'))
            sources = public_sources(config['worker_url'], families)
            auto_listener = job['id']
            worker_listener(config['worker_url'], token, job['id'], 'start', sources)
        else:
            host = target['management_host']
            protected = target.get('listener_mode') == 'ufw-source'
            if target.get('listener_mode') not in (None, 'ufw-source'):
                raise ValueError('invalid listener mode')
            sources = public_sources(config['worker_url']) if protected else None
            listener = start_listener(host, target.get('identity_file'), sources)
        if job.get('source') == 'onboarding':
            check_auto_target(target, args.output, job['id'])
        else:
          with tempfile.TemporaryDirectory(prefix='cfsm-iperf-') as temp:
            probe_config = Path(temp) / 'target.json'
            probe_config.write_text(json.dumps({'worker_url': config['worker_url'], 'targets': [target]}))
            command = [sys.executable, str(Path(__file__).with_name('iperf-report.py')), str(probe_config),
                '--output', args.output, '--duration', str(job['duration_seconds'])]
            result = subprocess.run(command, env={**os.environ, 'IPERF_REPORT_TOKEN': token}, timeout=240)
            if result.returncode:
                raise RuntimeError(f'iperf report exited {result.returncode}')
            count = 2 * sum(bool(target.get(family)) for family in ('ipv4', 'ipv6'))
    except Exception as exc:
        error = str(exc)[:200]
    finally:
        if durable_listener:
            try:durable_listener.stop()
            except Exception as exc:
                cleanup_ok=False;error=(error+'; ' if error else '')+'cleanup: '+str(exc)[:160]
        if auto_listener:
            try:
                worker_listener(config['worker_url'], token, auto_listener, 'stop')
            except Exception as exc:
                cleanup_ok=False
                error = f'{error or ""}; cleanup: {exc}'[:200]
        if listener:
            try:
                stop_listener(target['management_host'], *listener, target.get('identity_file'),
                    target.get('listener_mode') == 'ufw-source')
            except Exception as exc:
                cleanup_ok=False
                error = (error + '; ' if error else '') + f'cleanup: {exc}'
        completion={'id':job['id'],'status':'failed' if error else 'completed',
                    'result_count':count,'error':error,'cleanup_confirmed':cleanup_ok}
        write_receipt(state_dir/'pending-finish'/(job['id']+'.json'),completion)
        flush_completions(config['worker_url'],token,state_dir)
    if error:
        audit('job_failed', job_id=job['id'], error=error)
        raise RuntimeError(error)
    audit('job_completed', job_id=job['id'], result_count=count)
    print(f"completed {job['id']} ({count} results)")


if __name__ == '__main__':
    try:
        # 互斥锁防止重复执行常规测速任务。
        with open('/run/lock/cfsm-iperf-shared.lock', 'a') as measurement_lock:
            try:
                fcntl.flock(measurement_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                audit('waiting_for_runner')
                fcntl.flock(measurement_lock, fcntl.LOCK_EX)
            main()
    except Exception as exc:
        audit('runner_error', error=str(exc)[:500])
        print(f'error: {exc}', file=sys.stderr)
        sys.exit(1)
    finally:
        audit('runner_exit')
