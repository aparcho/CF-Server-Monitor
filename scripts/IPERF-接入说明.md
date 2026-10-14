# iperf3 测速接入

此功能从 `deb` 发起公网 IPv4/IPv6 TCP 单流测试。Worker 只接收摘要并展示，既有 Agent 不执行命令。测速会产生实际流量，建议先手动运行，再决定是否定时。

## 基线与回滚

- CFSM fork 基线：`eacb04720952f46d679f5bc99c9be98d62b74f3f`，本地备份 `../cf-server-monitor-pre-iperf-20261013.bundle`。
- SAO 主题当前 `dist` 基线：`7112fdbaa7b0f6b79c1c2536e1ed9b1e67f12499`，本地备份 `../cfsm-sao-pre-iperf-20261013.bundle`。
- CFSM 改动在 `aparcho/CF-Server-Monitor` 的 `feature/iperf-results` 分支；SAO 源码在 `aparcho/CFSM-SAO` 的同名分支，编译产物在该仓库的 `feature/iperf-dist` 分支。回滚 Worker 时部署上述 CFSM commit；回滚主题时将后台 `theme_url` 指回 SAO 的上述固定 commit。
- CFSM 远端备份分支已创建：`aparcho/CF-Server-Monitor` 的 `backup/pre-iperf-20261013`，指向上述基线 commit。当前线上 SAO 主题使用 WAOR 仓库的固定 `dist` commit；该 commit 和本地 bundle 均可用于回滚。
- 本轮扩展前的最新 Worker 版本另存为远端 `backup/pre-all-vps-20261014` 分支，指向 `fa872dd4ba2b4d4dceb2c9c083d9af8e82d07ab9`；本地完整备份为 `../cf-server-monitor-pre-all-vps-20261014.bundle`，已通过 `git bundle verify`。
- SAO 新编译产物的固定地址：`https://github.com/aparcho/CFSM-SAO/tree/e4695898731f593a6c162e24659fe6c11f55a57f`。上线前先使用后台预览验证，再将 `theme_url` 切到该地址。

## 准备

1. 在当前线上 Cloudflare Worker `cf-server-monitor` 的 Variables and Secrets 中设置独立的 `IPERF_REPORT_TOKEN` Secret。不要复用 `API_SECRET`。`wrangler.toml` 和 GitHub Actions 的 Wrangler 配置均已加入 `keep_vars = true`，避免部署时删除已有 Secret。仓库 Actions 工作流另写有 `server-monitor-pro`；配置 Secret 时应以线上实际绑定的 `cf-server-monitor` 为准。
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

每个目标依次执行 IPv4 下载、上传及 IPv6 下载、上传；`下载/上传` 均以 deb 为视角。默认每项 30 秒，单流，下载使用 `-R`，两项之间等待 2 秒。脚本请求服务端 JSON 输出以读取反向发送端的 TCP 重传。原始 JSON 与 stderr 留在 `--output/<run_id>/`，摘要写入同目录并上报。失败或超时不会写成 `0 Mbps`，重传次数也不表示物理丢包。

上报请求使用 `CFSM-Iperf/1.0` User-Agent；对 TLS/网络超时和服务端 5xx 最多重试两次。同一 `run_id` 在 D1 中幂等，重试不会生成重复记录。若测速成功但上报失败，应只重传已保存的 `summary.json`，不要自动重新测速。

## 验收

- 上报成功返回 `{ "success": true, "count": ... }`；重复上报相同 `run_id` 只更新同一行。
- SAO 节点详情出现 `iperf3 测速` 区域，按 IPv4/IPv6 和 deb 下载/上传显示最近结果、时间及测试条件。
- 使用相同源、出口、地址族、端口、方向和时长比较历史结果。SAO 节点详情显示最近结果，后台提供定时调度；历史曲线尚未加入。
- 测速端口的结果只证明该端口与这条路径，不能直接认定 Reality 或其他代理服务的质量。

## 手动触发与定时测速

CFSM 后台新增“测速”页，可逐台选择 10 秒或 30 秒单项时长，点击“开始测速”，并配置每日北京时间。所有定时配置默认关闭，需逐台保存启用。Worker 每分钟只把到点的任务写入 D1，实际测试仍由 `deb` 执行。后台展示等待、执行、完成、失败及最近任务。

`deb` 使用 `iperf-runner.py` 每分钟领取一个任务。只执行本机 JSON 白名单中的目标，目标需增加 `management_host`，例如 `root@lax`。执行器通过该管理连接在目标机临时启动 `5202` 监听，验证端口原本空闲及既有 `5201` 状态，然后调用 `iperf-report.py` 执行双栈、双向测试并上报；结束时按记录的 PID 清理监听，检查 `5201` 未变化。监听本身由 `timeout 600s` 兜底退出。目标机的 SSH 主机密钥应先核对并写入 deb 的 `known_hosts`，同时确认 `5202` 公网访问策略；未完成这些准备的节点不要加入白名单。

`OCI.TYO` 使用 `ubuntu` 管理账号和仅用于测速的 deb SSH 密钥，白名单目标可增加 `identity_file`。密钥路径只允许 `/root/.ssh/cfsm_iperf_*`，目标账号只允许 `root` 或 `ubuntu`。OCI 的 `authorized_keys` 将该公钥限制在 deb 的 Tailnet 来源，并禁用转发与交互终端；私钥留在 deb，不进入仓库或 Worker。

`AWS.TYO` 原有 UFW 规则拒绝公网 `5202`。该目标设置 `listener_mode: "ufw-source"`，并在目标机安装 `cfsm-iperf-ufw-listener.sh`。每次任务先通过本监控域名的 `/cdn-cgi/trace` 确认 deb 当前 IPv4/IPv6 公网源地址，再用 transient systemd service 在既有拒绝规则之前仅放行这两个源地址。服务退出时按专用注释和规则编号删除新增规则，停止 `5202` 监听；运行器核实端口与规则均已清理、`5201` 未改变。此模式依赖监控域名可访问 Cloudflare trace，取不到双栈源地址就拒绝运行。

执行器每分钟把本机白名单同步到 Worker。最近五分钟未同步的节点在后台显示“未接入 deb”，不能手动触发或启用定时任务；已有定时任务在目标不可用时不会排队。截至 2026-10-14，`DMIT.LAX`、`Legend.SG`、`OCI.TYO`、`AWS.HKG`、`AWS.TYO` 已加入 deb 白名单，手动完成双栈双向验收，定时开关均保持关闭。按当前接入决定，`HK-MO` 暂不接入：它是无主机防火墙管理权限的容器，公网 `5202` 到容器的映射尚未打通；该节点不加入白名单，也不开启定时任务。

可使用 `scripts/systemd/cfsm-iperf-runner.service` 和 `.timer` 在 deb 安装轮询。密钥仍仅保存在 `/root/.config/cfsm/iperf-token`，不写入 unit、仓库或浏览器。`iperf_jobs` 与 `iperf_schedules` 表由 Worker 自动创建。回滚时先停止 timer、等待正在运行的 service 完成，再恢复 deb 上的 `/root/iperf-runner-before-all-20261014.py` 与 `/root/cfsm-iperf-targets-before-all-20261014.json`；如需回滚 Worker，再部署备份 Worker。D1 历史任务和测速结果可保留，不影响旧版本运行。TYO 的专用脚本位于 `/usr/local/sbin/cfsm-iperf-ufw-listener`，回滚后确认 transient service 已停止且无 `CFSM deb temporary` 规则，再按需移除该脚本。
