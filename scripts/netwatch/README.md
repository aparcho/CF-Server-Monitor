# Monitor 持续速度探测

## Monitor 中使用

- 节点详情 → **测速** → **持续探测**：复用 SAO 原有折线与配色，查看 IPv4/IPv6 双向速率、Ping/TCP、波动、预算和分页明细；支持最近 1/6/24 小时，页面每 15 秒更新。
- 同一区域 → **对照验证**：自动把手动/定时常规 iperf 与前后 30 分钟的同协议、同方向持续探测匹配。常规 200 Mbps 与限速 2 Mbps 达标不算相互矛盾；两类同时低于档位才给出共同低速判断。缺少同期样本或少于两次有效小探测，明确显示证据不足。
- 后台 → **测速** → **持续探测设置与上报状态**：逐台启停、设置 2/5/10/15 分钟与每日预算，约一分钟内应用到 deb；不会突破节点已有防火墙能力。
- 首次补传保留已有真实探测记录，积压时约 5 秒一批，追平后每分钟同步。断线仅延后补传，幂等 ID 防止重复记录。
- WAWO.HK 按用户指示不纳入。新节点默认关闭；本轮已启用的四台保留设置，AWS.TYO 仅质量探测。
- 终端命令保留为排障入口，日常查看与管理通过 monitor 完成。

## 目的与测量边界

在 `deb` 上持续检测各 VPS 的公网 IPv4/IPv6。管理 SSH 可以经 Tailnet，Ping、TCP 握手与 iperf 数据只发往经过校验的公网地址。

这是一套小流量哨兵探测。常规结果为“达到 2 Mbps 探测上限”或本次小样本的实际速率，**不是峰值带宽**。它能帮助发现 200 Mbps 降到 0.5 Mbps 这类严重降速；无法用 2 Mbps 的探测证明线路仍有 200 Mbps，也无法保证识别 200 Mbps 降到 10 Mbps。原有 CFSM 大流量测速继续作为独立历史参考。

Ping 和 TCP 都是往返观测，不能分离单向延迟或物理单向丢包。上传/下载速率按 deb 视角分开记录。ICMP 未响应率、TCP 连接失败率、TCP 重传次数各有含义，不能互相替代。

## 已部署范围

- DMIT.LAX、Legend.SG、AWS.HKG、OCI.TYO：公网双栈、双向 iperf 哨兵探测，以及 Ping/TCP。
- AWS.TYO：Ping/TCP；现有防火墙明确拒绝公网 5202，本工具不会临时放行。
- WAWO.HK：按用户后续要求暂不加入本套持续监控，既不 Ping/TCP 探测，也不发起持续测速；原有 CFSM 探针和手动测速保留。
- 只读列出 deb 上原测速文件中已有的历史结果，附时间；这些旧结果不冒充实时测速。

未修改路由、防火墙、代理、SSH、Tailscale 或云安全组配置；没有调用 `gw 1`。当前 `deb` 的出口已经是 `192.168.50.1`，每轮以 `ip route get` 校验；出口漂移时暂停探测并记日志，不自动切换网关。

## 查看方法

```sh
ssh root@deb
netwatch watch                  # 每5秒重绘终端，Ctrl-C只退出查看
netwatch status                 # 一次性状态
netwatch history --node AWS.HKG --hours 24 --limit 40
netwatch compare --hours 24     # 各节点/协议/方向的成功率、中位速度、P10及重传
netwatch events --limit 30      # 异常、恢复、预算、清理记录
netwatch budget                # 北京时间当日用量与预留
journalctl -u cfsm-netwatch.service -n 50 --no-pager
```

图例：`≈2(0)/3分` 表示最近探测接近 2 Mbps 目标（达到目标的90%以上）、TCP 重传 0 次，样本为 3 分钟前。上传短样本可能受起步和往返时延影响，单次偏低只记为可疑，需重复样本和较大限量确认。小曲线在同一个探测速率上限下展示最近 8 次结果，`×` 是失败，不补零假装成功。

## 采样与自适应

| 项目 | 默认策略 |
| --- | --- |
| Ping/TCP | 每约 60 秒；每协议 3 次 Ping + 1 次真实 TCP connect |
| 延迟 | 近 15 分钟 TCP 中位/P95，展示 Ping 相邻 RTT 差值均值 |
| 常规速度 | 每协议、每方向约 5 分钟一次，TCP 单流，上限 2 Mbps |
| 限量 | `-n 65536 -l 8192`；iperf 字节终止按周期检查，真实传输通常大于 64 KiB，必须以 JSON 实测量计账 |
| 连续低速/失败/高重传 | 加密到约每 2 分钟；连续两次后排入限量确认 |
| 确认 | `-n 4194304 -b 20000000`，4 MiB 目标量、20 Mbps 上限，最长 15 秒；同方向确认间隔至少 1 小时 |
| 连通性/延迟异常 | 也会把该地址族速度检测间隔缩短到约 2 分钟 |
| 低速阈值 | 低于目标速率 65%；短样本只作候选异常 |
| 重传阈值 | 至少 10 次，且超过每 MiB 100 次，才视为重传异常 |
| ICMP 告警 | 近 15 分钟至少 12 次探测，未响应率达到 20% |
| 延迟异常 | 超过近期 Ping 中位的 2 倍或增加 50 ms 的较大者，连续两次记录事件 |
| 历史 | SQLite + 原始 iperf JSON/stderr，默认保留 30 天 |

任务串行执行，频率是目标间隔，会因超时、原有测速任务优先和预算限制顺延；不能称为逐秒实时带宽。终端的 5 秒是显示刷新频率。

异常记录在 SQLite `events` 表和本服务 journal 中。monitor 展示持续曲线与对照判断；当前没有额外外部推送渠道，也不会自行发送消息。

## 流量与预算

- 每节点每日预留上限 512 MiB，总上限 2048 MiB，按北京时间日期独立计账。
- 开始测速前，先在 SQLite 事务中预留整个超时窗口按限速可能产生的载荷，再加控制裕量。成功后按 iperf 实测发送/接收中较大的字节数与控制裕量结算；失败、崩溃或未知传输量保留全部预留。防止重启、并发或跨日重置绕过预算。
- `-n` 有周期性超发，不能把其参数值直接当作消耗。完整 JSON 的 `payload_bytes` 为已测应用字节，预算预留可能明显高于它；初始验收真实字节详见验收记录。
- **预算不是运营商账单的硬上限**：TCP/IP 首部、ACK、重传、SSH 管理流量及每分钟的 Ping/TCP 不包含在 iperf 应用字节内；没有修改防火墙或安装流量钩子来强制运营商计费级限流。未知失败量也不能伪称精确实测 0。
- 达到预算后停止主动 iperf，低流量 Ping/TCP 继续。低流量探测不写入原有 CFSM 测速评分，避免把 `≈2 Mbps` 当成线路峰值。

## 配置与维护

```sh
# 配置由root读取，包含节点地址和管理入口，不包含CFSM上报密钥
editor /etc/cfsm-netwatch/config.json
netwatch check
systemctl restart cfsm-netwatch.service
systemctl status cfsm-netwatch.service --no-pager
```

配置项见同目录 `config.example.json`。示例默认没有目标公网地址且未启用 iperf，填写真实节点后才能运行有效探测。`iperf_enabled` 只能在无需改防火墙且能管理临时监听的节点启用。编辑配置后先校验再重启；不自动改写原有 CFSM 目标清单。

部署位置：

- 程序：`/opt/cfsm-netwatch/netwatch.py`
- 命令：`/usr/local/bin/netwatch`
- 配置：`/etc/cfsm-netwatch/config.json`
- 数据：`/var/lib/cfsm-netwatch/monitor.sqlite3`，`raw/日期/`
- 新服务：`cfsm-netwatch.service`，启用开机自启和失败后自动恢复。

## 服务保护与回滚

原 runner 与新监控共用 `/run/lock/cfsm-iperf-shared.lock`。监控非阻塞取锁，并在原 runner 已激活时让行；原 runner 必要时等待当前一次短探测清理完成。原有任务通常只增加短暂等待，原有测速时长、调度、凭据和上报逻辑保持原样。

临时监听使用已安装的 iperf3 与已放行的 TCP 5202，一次只处理一个客户端，25 秒自动退出；即使控制进程失联也不会长期残留。记录 PID、进程启动时间和随机令牌，只回收自身进程组。正常与异常结束都检查 5202 已关闭、原 5201 监听未变；清理失败时暂停该节点主动测速。

停止新监控（保留历史）：

```sh
systemctl disable --now cfsm-netwatch.service
```

保留的 runner 备份：`/root/cfsm-netwatch-preflight-20261016/iperf-runner-before-shared-lock.py`。若需要连共享锁改动一起撤回，先停止新监控，再将备份原子恢复到 `/root/iperf-runner.py`，不必改旧 timer 或网络。基线路由和旧 unit 文本保存在同目录 `baseline.json`。不要删除原有 CFSM 数据、原有 iperf3 5201 服务或其他监控目录。

## 验证

```sh
python3 test/netwatch.test.py
python3 test/iperf-report.test.py
```

本地测试另覆盖断线游标、幂等补传、私有字段剔除与后台配置应用；后端/主题测试覆盖对照逻辑、设置保留及图表展示。本地测试覆盖公网地址拒绝、出口变化阻止探测、持久预算、超时清理、原任务优先、接收端吞吐/服务端重传和自适应确认。部署后还需检查真实采样、原始 JSON、端口回收、未变的 5201 与旧 runner 日志。只通过测试用例不代表完成公网路径验收。

## 参数参考

[iperf3 官方参数说明](https://software.es.net/iperf/invoking.html)：`-b` 设置目标速率，`-n` 设置目标字节数，`-R` 反向传输。以部署版本的帮助和实际 JSON 验证结果为准。

## 集成上报与回滚

Worker 提供专用 `/api/netwatch/report`（复用已有 `IPERF_REPORT_TOKEN`）及遵守站点访问权限的 `/api/netwatch/results`，持续样本保存在独立 D1 表，不混入原 `iperf_results`，不影响原评分。管理主机、密钥路径、原始命令/日志不上传。

集成前的程序、配置和 SQLite 一致性快照保存在 deb `/root/cfsm-netwatch-preflight-20261016/monitor-integration/`。主题旧固定版本为 `79de5e185233b431ec8ae4bad85c3dbc3364ef23`，可在后台主题商店切回。集成版本的具体提交及验收见后续记录。

2026-10-16 后续已从 Cloudflare 错误日志确认旧 1101 根因：`iperf_targets.server_id` 主键冲突，自动接入与 deb 刷新写同节点。已改为事务内 upsert、清除过期静态目标，保留其他自动节点；真实 runner 已恢复 `targets → claim → claim_empty` 正常闭环。
