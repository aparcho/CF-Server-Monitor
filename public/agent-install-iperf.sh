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
# 依赖安装是可选步骤，不能让测速助手的错误掩盖已成功安装的监控探针。
apt_with_lock_wait() {
  apt_started=$(date +%s)
  while :; do
    if LC_ALL=C apt-get -o DPkg::Lock::Timeout=0 "$@" >"$task_dir/apt.log" 2>&1; then
      cat "$task_dir/apt.log"
      return 0
    fi
    if ! grep -Eq 'Could not get lock|Unable to acquire.*lock|Unable to lock directory' "$task_dir/apt.log"; then
      cat "$task_dir/apt.log" >&2
      return 1
    fi
    if [ "$(( $(date +%s) - apt_started ))" -ge 300 ]; then
      cat "$task_dir/apt.log" >&2
      echo '等待系统软件更新释放 apt/dpkg 锁超时（5 分钟）。' >&2
      return 1
    fi
    echo '系统正在安装或更新软件；测速助手等待 apt/dpkg 锁释放，10 秒后重试。'
    sleep 10
  done
}

base=''
for arg in "$@"; do
  case "$arg" in -url=*) base=${arg#-url=}; base=${base%/update};; esac
done
case "$base" in https://*) ;; *) echo '自动测速接入需要 HTTPS Worker 地址'; exit 0;; esac
if ! command -v python3 >/dev/null || ! command -v iperf3 >/dev/null || ! command -v iptables >/dev/null; then
  if command -v apt-get >/dev/null; then
    if ! apt_with_lock_wait update -qq ||
       ! DEBIAN_FRONTEND=noninteractive apt_with_lock_wait install -y python3 iperf3 iptables; then
      echo '监控探针已安装成功；测速助手暂未安装。请等待系统更新完成后重新运行原安装命令。无需删除锁文件或停止系统更新。'
      exit 0
    fi
  elif command -v dnf >/dev/null; then
    if ! dnf install -y python3 iperf3 iptables; then
      echo '监控探针已安装成功；测速助手依赖安装失败，请稍后重新运行原安装命令。'
      exit 0
    fi
  elif command -v yum >/dev/null; then
    if ! yum install -y python3 iperf3 iptables; then
      echo '监控探针已安装成功；测速助手依赖安装失败，请稍后重新运行原安装命令。'
      exit 0
    fi
  else
    echo '监控探针已安装；自动测速助手缺少依赖，当前系统不能自动安装。'
    exit 0
  fi
fi
if ! curl -fsSL "$base/iperf-node.py" -o "$task_dir/iperf-node.py"; then
  echo '监控探针已安装成功；测速助手下载失败，请稍后重新运行原安装命令。'
  exit 0
fi
install -m 700 "$task_dir/iperf-node.py" /usr/local/sbin/cfsm-iperf-node
python3 /usr/local/sbin/cfsm-iperf-node install "$@" || {
  echo '监控探针已安装；自动测速助手安装失败，请查看上述错误。'
  exit 0
}
