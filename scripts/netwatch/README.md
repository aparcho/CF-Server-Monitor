# 持续探测已移除

按用户要求于 2026-10-16 退役。monitor 仅保留常规 iperf3 手动测速、定时测速、历史图表、分页和原有网络评分。

- deb 的 cfsm-netwatch.service 已停止、取消自启并卸载；活动程序、配置和 SQLite 数据目录已移出。
- 离线回滚备份：deb:/root/cfsm-retired-backups/netwatch-20261016-201705/。
- 旧 /api/netwatch/report 仅作鉴权退役入口：清理持续探测专属 D1 表后返回 410，不接受新样本。持续探测查询和后台配置接口已移除。
- 旧代码保存在 Git 历史及 backup/pre-remove-netwatch-worker-20261016 分支；主题变更前分支为 backup/pre-remove-netwatch-20261016。
- 常规 iperf 上报令牌、节点助手、5202 临时监听逻辑和所有常规定时计划继续使用，不修改路由、防火墙、代理、SSH 或 Tailscale。
