#!/bin/bash
# TYO: expose iperf3 only to deb while this transient service is running.
set -euo pipefail

source_v4=$1
source_v6=$2
python3 - "$source_v4" "$source_v6" <<'PY'
import ipaddress, sys
assert ipaddress.ip_address(sys.argv[1]).version == 4
assert ipaddress.ip_address(sys.argv[2]).version == 6
PY

if ss -ltn '( sport = :5202 )' | tail -n +2 | grep -q .; then
  echo 'port 5202 busy' >&2
  exit 2
fi
if ufw status | grep '5202/tcp' | grep -Fq "$source_v4" ||
   ufw status | grep '5202/tcp' | grep -Fq "$source_v6"; then
  echo 'source rule already exists' >&2
  exit 3
fi

added_v4=0
added_v6=0
child_pid=''
delete_owned_rule() {
  local source=$1 line number
  line=$(ufw status numbered | grep -F "$source" | grep -F '# CFSM deb temporary' || true)
  if [[ -n "$line" && $(printf '%s\n' "$line" | wc -l) -eq 1 ]]; then
    number=$(printf '%s\n' "$line" | sed -n 's/^\[ *\([0-9][0-9]*\)\].*/\1/p')
    test -n "$number" && ufw --force delete "$number"
  fi
}
cleanup() {
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  if (( added_v6 )); then
    delete_owned_rule "$source_v6" || true
  fi
  if (( added_v4 )); then
    delete_owned_rule "$source_v4" || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM

ufw insert 1 allow in on ens5 from "$source_v4" to any port 5202 proto tcp comment 'CFSM deb temporary'
added_v4=1
v6_position=$(ufw status numbered | sed -n '/5202\/tcp (v6) on ens5.*DENY/{s/^\[ *\([0-9][0-9]*\)\].*/\1/p;q;}')
test -n "$v6_position"
ufw insert "$v6_position" allow in on ens5 from "$source_v6" to any port 5202 proto tcp comment 'CFSM deb temporary'
added_v6=1

timeout -k 10s 600s iperf3 -s -p 5202 &
child_pid=$!
wait "$child_pid"
