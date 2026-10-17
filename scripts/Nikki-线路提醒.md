# Nikki 在用线路提醒

## 工作方式

50.2 上的 `cfsm-nikki-watch` 每 60 秒只读本机 Mihomo `/connections`，读取实际连接链首跳和当前运行 provider。只上传 Monitor 节点 ID、确定的 IPv4/IPv6 地址族、连接数与时间；不上传访问域名、客户端 IP、代理密码或策略组名称。

同一连接 120 秒没有字节增长后，不再视为使用中。`DIRECT` 不关联；域名入口只有明确强制 `ipv4` / `ipv6` 时才关联，`ipv6-prefer` 等可回退设置不会被猜测。中转关联首跳入口，VPS 评分不能代表中转后整条线路。未映射及地址族不明的连接暂不告警。

Worker 采用原有估算 v0.2 公式、现有移动双栈 `node_1` / `node_2` 探针的近 2 小时历史和最近 80 条常规 iperf 结果评估。页面的在用线路直接显示后台本次评分及依据，保持显示与提醒一致；未使用线路维持原来的前端评分。公式位于 `src/utils/networkEstimate.js`，由 SAO 的 `src/utils/networkEstimate.ts` 导出，修改公式时两端须同步。移动探针对应字段改变时须调整 `scoreProbe`，不能套用其他运营商。

## 提醒规则

- 在用线路低于 60 分连续 5 分钟后，复用 Monitor 已配置的通知渠道提醒一次。
- 恢复到 65 分后解除；60–64 分保留已触发事件，避免反复提醒。
- 没有有效评分时显示数据不足，打断低分计时，不补零。
- 采集间隔超过 150 秒时清除在用标识并重新计时，避免用陈旧线路发提醒。
- 没有通知渠道或发送失败时，评分依据弹窗显示原因，后续上报继续重试。
- 只提醒，不写 Mihomo API，不切换节点，不改路由、Nikki profile、代理或防火墙。

## 运行与回滚

路由器命令：

```sh
/etc/init.d/cfsm-nikki-watch status
logread -e cfsm-nikki-watch
/usr/bin/python3 /usr/libexec/cfsm-nikki-watch.py --once --dry-run
```

只停止联动：

```sh
/etc/init.d/cfsm-nikki-watch stop
/etc/init.d/cfsm-nikki-watch disable
```

150 秒后页面在用标识自动失效。原有探针和测速继续运行。回滚基线为 Worker / SAO 的本地 `backup/pre-nikki-link-20261017` 分支；线上主题旧版本为 `1ea8176cc4106e7bcd988c0814ce35886e9506fd`。

配置 `/etc/cfsm-nikki-watch/config.json` 权限 600。其上报凭证由 deb 的独立 runner 密钥通过 HMAC 派生，仅能调用 `/api/nikki/report`，不能调用测速或管理接口。不要输出、提交或公开该配置。采集器不进行 iperf 测速，增加的流量只有每分钟小型 HTTPS 上报。
