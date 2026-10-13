# iperf3 测速接入

此功能从 `deb` 发起公网 IPv4/IPv6 TCP 单流测试。Worker 只接收摘要并展示，既有 Agent 不执行命令。测速会产生实际流量，建议先手动运行，再决定是否定时。

## 基线与回滚

- CFSM fork 基线：`eacb04720952f46d679f5bc99c9be98d62b74f3f`，本地备份 `../cf-server-monitor-pre-iperf-20261013.bundle`。
- SAO 主题当前 `dist` 基线：`7112fdbaa7b0f6b79c1c2536e1ed9b1e67f12499`，本地备份 `../cfsm-sao-pre-iperf-20261013.bundle`。
- 两份代码的改动均在 `feature/iperf-results` 分支。回滚 Worker 时部署上述 CFSM commit；回滚主题时将后台 `theme_url` 指回 SAO 的上述固定 commit。
- CFSM 远端备份分支已创建：`aparcho/CF-Server-Monitor` 的 `backup/pre-iperf-20261013`，指向上述基线 commit。当前线上 SAO 主题使用 WAOR 仓库的固定 `dist` commit；该 commit 和本地 bundle 均可用于回滚。

## 准备

1. 在 Cloudflare Worker 的 Variables and Secrets 中设置独立的 `IPERF_REPORT_TOKEN` Secret。不要复用 `API_SECRET`。部署工作流的 Wrangler 配置已加入 `keep_vars = true`，避免部署时删除已有 Secret。
2. 在 deb 确认 `gw 1` 出口使用 `192.168.50.1`，安装 `iperf3`。目标 VPS 需准备**授权且隔离**的公网 TCP 监听端口，例如 `5202`；不要占用既有 `5201` 服务。此脚本不会启动或清理目标监听，只有确认监听和防火墙策略后才运行。
3. 从 CFSM 管理后台查每台服务器的真实 `id`，创建仅存于 deb 的配置文件：

```json
{
  "worker_url": "https://你的监控域名",
  "targets": [
    {"id": "CFSM中的服务器ID", "ipv4": "公网IPv4", "ipv6": "公网IPv6", "port": 5202}
  ]
}
```

4. 在 deb 执行：

```sh
export IPERF_REPORT_TOKEN='从安全位置读取的独立密钥'
python3 iperf-report.py targets.json --output ./iperf-results
```

每个目标依次执行 IPv4 下载、上传及 IPv6 下载、上传；`下载/上传` 均以 deb 为视角。默认每项 30 秒，单流，下载使用 `-R`。原始 JSON 与 stderr 留在 `--output/<run_id>/`，摘要写入同目录并上报。失败或超时不会写成 `0 Mbps`，重传次数也不表示物理丢包。

## 验收

- 上报成功返回 `{ "success": true, "count": ... }`；重复上报相同 `run_id` 只更新同一行。
- SAO 节点详情出现 `iperf3 测速` 区域，按 IPv4/IPv6 和 deb 下载/上传显示最近结果、时间及测试条件。
- 使用相同源、出口、地址族、端口、方向和时长比较历史结果。当前 UI 先展示最近结果；历史曲线与定时调度留给后续版本。
- 测速端口的结果只证明该端口与这条路径，不能直接认定 Reality 或其他代理服务的质量。
