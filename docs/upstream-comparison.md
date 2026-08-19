# CF-Server-Monitor 与 Komari：决策总览

> 快照日期：2026-08-18。本页只保留架构决策和结论入口；完整逐项证据、评分与 Cloudflare 免费层限制见下方两份研究文档。

- [Komari 全能力对比与 CF 路线图](capability-roadmap-2026.md)
- [Cloudflare 免费平台能力核验（2026）](cloudflare-free-platform-2026.md)

## 固定快照

| 项目 | 固定提交 | 提交时间 | 许可 |
| --- | --- | --- | --- |
| CF-Server-Monitor | [`a4911ff`](https://github.com/huilang-me/CF-Server-Monitor/tree/a4911ffa8664e047ea672d735a32d8ffde1c01da) | 2026-08-15 | `package.json` 声明 MIT，但该快照根目录没有 `LICENSE` 文件 |
| cfsm-agent | [`b435168`](https://github.com/huilang-me/cfsm-agent/tree/b435168ab8585aed10801d3e2918ba2fa09342b4) / `v1.0.8` | 2026-08-17 | [MIT](https://github.com/huilang-me/cfsm-agent/blob/b435168ab8585aed10801d3e2918ba2fa09342b4/LICENSE) |
| Komari | [`da4d518`](https://github.com/komari-monitor/komari/tree/da4d5187c1b10da3c5893595c5e2a9fd54d13792) | 2026-08-17 | [MIT](https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/LICENSE) |

## 架构决策

| 维度 | CF-Server-Monitor 底座 | Komari 参考 | 本项目决策 |
| --- | --- | --- | --- |
| 部署 | Workers + D1 + Durable Objects + Static Assets | 长驻 Go 服务 + 文件系统 + SQLite/MySQL/PostgreSQL | 保留 Cloudflare 原生架构 |
| Agent | `cfsm-agent` 单向 HTTPS/WSS 上报 | 双向 Agent，支持任务和终端 | 继续单向监控边界；只为 PingTask 扩协议 |
| 实时 | DO + WebSocket，前端 Hibernation，Agent 可回退 HTTP | 长驻进程长连接 | 保留实时与持久化解耦、按订阅节流 |
| 历史 | D1 7 天历史和长时段抽样 | metric store、rollup、百分位、单指标 retention | 不移植存储引擎；按 D1 写入额度优化 |
| 扩展 | 远程前端主题 | 高权限服务端插件与 JS runtime | 保留安全主题模型；不引入服务端插件 |
| 恢复 | D1 Time Travel，尚缺产品化导出 | ZIP、文件系统快照和分片恢复 | 设计 D1 导出 + 可选 R2，不照搬 ZIP 恢复 |

## 已确认的高价值差异

优先借鉴：

1. 登录安全事件与管理操作审计。
2. 内部备注和公开备注分离。
3. 补齐 `min` 流量算法。
4. 通知投递状态、失败重试和 Provider 结构化配置。
5. Session、TOTP、GitHub OAuth / generic OIDC。
6. 任意 ICMP/TCP/HTTP PingTask。
7. D1 导出与 R2 备份。

截至 2026-08-19，本地 `codex/reboot-foundation` 已完成第 6 项的第一版：Worker 管理任务与历史，`cfsm-agent` 在本地执行 ICMP/TCP/HTTP 并随指标单向回传结果；公开 API 不返回目标地址，节点详情通过单次聚合查询展示全部任务。该实现没有引入 Komari Agent 协议或任何反向命令通道，尚未部署。

保留 CFSM 自身优势：

- Static Assets 前端、D1、DO 实时广播。
- HTTP/WSS 动态切换、服务端时间校准、订阅感知节流。
- 三网与可选 BD 延迟/丢包。
- 条形、环形、表格、地图视图。
- GitHub Pages 多 API 聚合与 iOS Scriptable 小组件。
- D1 / Workers / DO 用量查询。

## 已纠正的三项误读

- Komari 当前只在成功创建 Session 后发送登录通知；未发现登录失败通知。
- Komari 内建日/周/月流量报告虽然当前可用，但源码明确提示将在 1.5.0 移除并迁往插件。
- `NextTrace`、`iperf3`、`MeshTrace` 目前只属于 v2 协议预留；没有完整的产品注册、路由、调度和管理链路。

## 明确不做

- Komari Agent 协议兼容。
- WebSSH、远程 shell、远程命令、反向主控和剪贴板。
- Komari 插件市场、JS/Node-like runtime、HTTP/WS hook、child process、本地监听和全文件系统权限。
- 为模仿 Komari 的外部数据库而引入 Hyperdrive。
- 用 Queues 中转每个实时指标包。

当前独立测试环境及不可触碰边界见 [DEPLOYMENT.md](DEPLOYMENT.md)。
