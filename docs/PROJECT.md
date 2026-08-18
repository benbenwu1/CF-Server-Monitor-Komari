# CF-Server-Monitor-Komari 项目基线

## 目标

以 [`huilang-me/CF-Server-Monitor`](https://github.com/huilang-me/CF-Server-Monitor) 为 Cloudflare 原生底座，吸收 [`komari-monitor/komari`](https://github.com/komari-monitor/komari) 中适合无服务器环境的监控与管理体验，做一个可长期维护、可同步上游的独立 Fork。

Cloudflare 上运行的是面板、API、实时广播和数据库；探针仍运行在被监控的 VPS/主机上，通过 HTTPS/WSS 单向上报到 Cloudflare。

当前状态（2026-08-18）：Phase 0 已完成，独立 Cloudflare 环境与真实 VPS Agent 已打通。资源、验证证据和运维边界见 [`DEPLOYMENT.md`](DEPLOYMENT.md)。

## 上游关系

- `origin`: `benbenwu1/CF-Server-Monitor-Komari`
- `upstream`: `huilang-me/CF-Server-Monitor`，只允许拉取
- Komari 是产品和功能参考，不将其 Go 服务端嵌入 Workers
- 探针优先使用 `huilang-me/cfsm-agent`，不在第一阶段兼容 Komari Agent 协议

## 第一阶段必须保留

1. Cloudflare Workers + D1 + Durable Objects + Static Assets 原生部署。
2. Go Agent 的 HTTPS/WSS 单向上报，以及 POST fallback。
3. CPU、GPU、内存、swap、磁盘/磁盘 IO、网络、连接数、进程数、负载、uptime 实时监控。
4. 7 天历史图表、长时段采样、月流量和流量重置。
5. 电信、联通、移动三网，以及可选 `BD` 第四自定义节点的延迟与丢包率。
6. 节点增删改查、排序、隐藏、分组、地图、计费/到期信息。
7. 离线、恢复、到期和资源负载告警。
8. 管理员认证、JWT、Turnstile、CORS 和 CSP。
9. 中英文、移动端、多视图和主题能力。

## 从 Komari 借鉴的方向

- 更清晰的节点详情和历史指标编组。
- 登录事件通知、审计日志和更细的访客权限。
- 周期流量报告和更完整的通知策略。
- 可管理的主题配置，而不是把任意服务端代码引入 Workers。

每个候选功能须先通过以下检查：Cloudflare 免费额度、D1 读写量、Durable Objects 持续时长、权限模型、与上游合并成本。

## 明确不做

- WebSSH、远程 shell、远程命令和反向主控通道。
- 把 Komari 的本地 SQLite/PostgreSQL、进程管理、嵌入式 JavaScript 运行时或插件后端直接搬到 Workers。
- 复用上一版 `/Users/yong/Desktop/AI-Yong/cf-komari` 的协议适配层或数据库。
- 修改或停止现有的 `https://vps.i404.dev` 与其 Komari Agent。

## 独立测试资源

新项目必须使用独立的 Worker、D1、Durable Object 命名空间、Secret 和测试 Agent。不得复用上一版 `cf-komari-worker`、`cf-komari-db` 或 `mon-jp` token。

当前测试环境使用 `cf-server-monitor-komari` Worker、`cf-server-monitor-komari-db` D1 和全新随机 `API_SECRET`。Secret 只存在 Cloudflare Secret 与 macOS Keychain，不写入 Git、文档或 shell 历史。

## 第一阶段验收

- [x] 上游原始构建和全部测试通过。
- [x] 没有 Critical/High 级已知依赖漏洞；`nanoid` 已从 `3.3.17` 最小升级到 `3.3.18`。
- [x] 新 Cloudflare 测试环境可登录、可添加节点、可生成安装命令。
- [x] 独立 VPS 使用 `cfsm-agent v1.0.8` 连接，实时指标、D1 历史、三网延迟/丢包率均有真实数据。
- [x] 真实浏览器完成访客前台、节点详情、管理后台登录与 1440px/390px 宽度验收。
- [x] HTTP POST 和 Agent WSS 均已真实验证；验证后恢复默认 HTTP，避免测试环境长期占用 DO duration。
- [ ] 在扩容节点前持续观察 Worker/D1/DO 实际用量，建立用量基线。
