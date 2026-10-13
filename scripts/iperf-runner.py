#!/usr/bin/env python3
"""Claim CFSM iperf jobs on deb and run only locally allowlisted targets."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def api(base, token, path, payload):
    if any(char in token for char in '\r\n"\\'):
        raise ValueError('invalid token format')
    with tempfile.NamedTemporaryFile(mode='w', prefix='.cfsm-curl-', dir='/root/.config/cfsm') as options:
        options.write(f'header = "X-Iperf-Token: {token}"\n')
        options.flush()
        result = subprocess.run(['curl', '--silent', '--show-error', '--fail-with-body', '--ipv6',
            '--connect-timeout', '10', '--max-time', '30', '--config', options.name,
            '--header', 'Content-Type: application/json', '--header', 'User-Agent: CFSM-Iperf/1.0',
            '--data-binary', '@-', base.rstrip('/') + path], input=json.dumps(payload),
            text=True, capture_output=True, timeout=35)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()[:200] or 'Worker request failed')
    return json.loads(result.stdout)


def remote(host, script, timeout=20):
    if not re.fullmatch(r'root@[a-zA-Z0-9.-]{1,100}', host):
        raise ValueError('invalid management host')
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'sh', '-s'],
        input=script, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()[:200] or 'remote command failed')
    return result.stdout.strip()


def start_listener(host):
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
''')
    parts = output.splitlines()
    if not parts or not parts[0].isdigit():
        raise RuntimeError('remote listener returned no PID')
    return int(parts[0]), '\n'.join(parts[1:])


def stop_listener(host, pid, before):
    if not isinstance(pid, int) or pid < 2:
        raise ValueError('invalid listener PID')
    script = f'''set -eu
pid={pid}
if [ -r "/proc/$pid/cmdline" ] && tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -q 'timeout 600s iperf3 -s -p 5202'; then kill "$pid"; fi
sleep 1
if ss -ltn '( sport = :5202 )' | tail -n +2 | grep -q .; then echo 'port 5202 remains occupied' >&2; exit 4; fi
ss -ltnp '( sport = :5201 )' | tail -n +2
'''
    after = remote(host, script)
    if after != before:
        raise RuntimeError('pre-existing port 5201 listener changed')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config', help='local allowlist JSON with worker_url and targets')
    parser.add_argument('--token-file', default='/root/.config/cfsm/iperf-token')
    parser.add_argument('--output', default='/root/cfsm-iperf-results')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    token = Path(args.token_file).read_text().strip()
    if not token:
        raise ValueError('empty token file')
    api(config['worker_url'], token, '/api/iperf/targets',
        {'server_ids': [target['id'] for target in config['targets']]})
    job = api(config['worker_url'], token, '/api/iperf/jobs/claim', {})
    if not job:
        print('no queued job')
        return
    error = None
    count = 0
    listener = None
    target = next((x for x in config['targets'] if x['id'] == job['server_id']), None)
    try:
        if target is None:
            raise ValueError('target not configured on deb')
        if int(target.get('port', 5202)) != 5202:
            raise ValueError('only isolated port 5202 is supported')
        host = target['management_host']
        listener = start_listener(host)
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
        if listener:
            try:
                stop_listener(target['management_host'], *listener)
            except Exception as exc:
                error = (error + '; ' if error else '') + f'cleanup: {exc}'
        api(config['worker_url'], token, '/api/iperf/jobs/finish', {
            'id': job['id'], 'status': 'failed' if error else 'completed',
            'result_count': count, 'error': error})
    if error:
        raise RuntimeError(error)
    print(f"completed {job['id']} ({count} results)")


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'error: {exc}', file=sys.stderr)
        sys.exit(1)
