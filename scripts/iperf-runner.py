#!/usr/bin/env python3
"""Claim CFSM iperf jobs on deb and run only locally allowlisted targets."""
import argparse
import ipaddress
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


def public_sources(base):
    sources = []
    for family in (4, 6):
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
        protected = target.get('listener_mode') == 'ufw-source'
        if target.get('listener_mode') not in (None, 'ufw-source'):
            raise ValueError('invalid listener mode')
        sources = public_sources(config['worker_url']) if protected else None
        listener = start_listener(host, target.get('identity_file'), sources)
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
                stop_listener(target['management_host'], *listener, target.get('identity_file'),
                    target.get('listener_mode') == 'ufw-source')
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
