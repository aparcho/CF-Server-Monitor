#!/bin/sh
# 安装官方探针，并为支持的 Linux 主机配置自动测速接入。
set -eu
task_dir=$(mktemp -d)
trap 'rm -rf "$task_dir"' EXIT
curl -fsSL https://raw.githubusercontent.com/huilang-me/cfsm-agent/main/install.sh -o "$task_dir/install.sh"
sh "$task_dir/install.sh" "$@"
if [ "$(id -u)" != 0 ] || [ ! -d /run/systemd/system ]; then
  echo '监控探针已安装；自动测速助手需要 Linux root 和 systemd，本机未接入自动测速。'
  exit 0
fi
base=''
for arg in "$@"; do
  case "$arg" in -url=*) base=${arg#-url=}; base=${base%/update};; esac
done
case "$base" in https://*) ;; *) echo '自动测速接入需要 HTTPS Worker 地址'; exit 0;; esac
if ! command -v python3 >/dev/null || ! command -v iperf3 >/dev/null || ! command -v iptables >/dev/null; then
  if command -v apt-get >/dev/null; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3 iperf3 iptables
  elif command -v dnf >/dev/null; then
    dnf install -y python3 iperf3 iptables
  elif command -v yum >/dev/null; then
    yum install -y python3 iperf3 iptables
  else
    echo '监控探针已安装；自动测速助手缺少依赖，当前系统不能自动安装。'
    exit 0
  fi
fi
curl -fsSL "$base/iperf-node.py" -o "$task_dir/iperf-node.py"
install -m 700 "$task_dir/iperf-node.py" /usr/local/sbin/cfsm-iperf-node
python3 /usr/local/sbin/cfsm-iperf-node install "$@" || {
  echo '监控探针已安装；自动测速助手安装失败，请查看上述错误。'
  exit 0
}
