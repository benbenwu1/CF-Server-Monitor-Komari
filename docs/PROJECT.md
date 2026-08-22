# CF-Server-Monitor-Komari 项目基线

## 目标

以 [`huilang-me/CF-Server-Monitor`](https://github.com/huilang-me/CF-Server-Monitor) 为 Cloudflare 原生底座，吸收 [`komari-monitor/komari`](https://github.com/komari-monitor/komari) 中适合无服务器环境的监控与管理体验，做一个可长期维护、可同步上游的独立 Fork。

Cloudflare 上运行的是面板、API、实时广播和数据库；探针仍运行在被监控的 VPS/主机上，通过 HTTPS/WSS 单向上报到 Cloudflare。

当前状态（2026-08-22）：Phase 0、P0、P1 和第一阶段验收均已完成。代码基线 `7179aa3` 已部署为 Worker Version `957953be-4b36-4a6d-92a9-ebe549821438`；正式 Agent `v1.0.10` 继续运行于独立测试节点。P2.1 已真实返回 1 个物理核心和 `kvm/guest`，HTTP 上报、D1、公开 API 与健康检查正常。专用通知 Queue 已创建并同时绑定 producer/consumer，流量快照继续保持 `off`；隔离 D1 全量备份 Workflow 仍未部署。P2.2 Analytics Engine 代码已上线但 `CFSM_ANALYTICS` binding 未启用。TOTP、GitHub OAuth 和私有 R2 仍因相应 Secret/App/binding 未配置而保持关闭。资源、验证证据和运维边界见 [`DEPLOYMENT.md`](DEPLOYMENT.md)。

Phase 0 之后的功能开发以以下研究与运维基线为准：

- [`capability-roadmap-2026.md`](capability-roadmap-2026.md)：Komari 全能力、当前 Fork 源码、线上启用状态和 P0/P1/P2 评分矩阵。
- [`cloudflare-free-platform-2026.md`](cloudflare-free-platform-2026.md)：Cloudflare 官方免费额度、新增产品能力与本项目采用边界。
- [`github-oauth-official-2026.md`](github-oauth-official-2026.md)：GitHub OAuth 与 Cloudflare Workers 的 2026 官方协议、安全和部署依据。
- [`logical-backup-2026.md`](logical-backup-2026.md)：D1/Time Travel/完整 SQL 导出与脱敏配置备份的边界，以及可选私有 R2 契约。
- [`OPERATIONS.md`](OPERATIONS.md)：D1 Time Travel 恢复、Workers Logs/Traces 采样、脱敏和配额运维手册。
- [`usage-baseline-2026-08-20.md`](usage-baseline-2026-08-20.md)：当前 Worker/D1/DO 实际用量、容量判断和扩容前门禁。
- [`p2-priorities-2026-08-20.md`](p2-priorities-2026-08-20.md)：P2 四档优先级、启动门槛和明确排除项。

控制面 P0/P1、通知 Queue 兼容代码、周期流量快照默认关闭逻辑、P2.1 Worker/Agent 正式版和 P2.2 未绑定代码均已部署到独立测试环境。下一步可部署通知 Queue，或单独授权启用 Analytics Engine 进行 14 天 shadow；GPU 温度与逐卡显存永久排除。

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

- P0：登录成功/失败安全事件、管理操作审计、内部/公开备注、`min` 流量算法、通知投递状态。
- P1：Session、TOTP、GitHub OAuth 或 generic OIDC、任意 ICMP/TCP/HTTP PingTask、D1 导出与可选 R2 备份。
- P2：节点静态信息补齐、Analytics Engine 遥测，以及有真实需求后再试点的 Browser Run / Workflows；GPU 温度与逐卡显存已明确排除。
- 保留 CFSM 的主题模型，不把 Komari 的任意服务端代码引入 Workers。

每个候选功能须先通过以下检查：Cloudflare 免费额度、D1 读写量、Durable Objects 持续时长、权限模型、与上游合并成本。

Komari 当前只有登录成功通知；内建周期流量报告已声明将在 1.5.0 移除；NextTrace、iperf3 和 MeshTrace 只是协议预留。这三项不得再按成熟上游能力排期。

## P0 实施结果（本地分支）

- [x] 登录成功/失败安全事件；失败按 IP 和五分钟窗口聚合，每窗口最多写 20 次；审计保留 90 天。
- [x] 节点、设置、通知测试与批量节点操作审计；认证接口支持事件类型筛选、分页和最多 100 条/页。
- [x] 独立管理审计 Tab 按需加载，每页固定读取 20 条，支持事件类型精确筛选、刷新和前后翻页。
- [x] 审计写入采用 best-effort 故障隔离，不会把已完成的业务写入或正常 401 响应误报成 500；失败日志不包含 Secret。
- [x] `internal_note` / `public_note` 分离；旧 `note` 自动迁移为内部备注，公开 API 只返回公开备注。
- [x] 流量口径增加 `min`，并锁定 `total`、`ul`、`dl`、`max` 四种旧结果不变。
- [x] 通知 Provider 显式化并兼容原九类格式；返回安全的结构化重试结果，投递记录保留 30 天，设置读取不回显通知凭据。
- [x] Provider 变更必须显式提交替换凭据，避免把旧 Provider 的 Token 误用于新渠道。
- [x] 免费额度面板使用统一常量，并按 2026-08-18 Cloudflare 官方 D1、Workers、Durable Objects 页面复核。
- [x] 增加 D1 Time Travel、Workers Logs / Traces 采样与脱敏运维手册；UTC 00:00 Cron 幂等初始化后清理过期控制面记录。

当前全量验证结果见下方 P1 工作包记录。管理审计已具备完整 API 和独立界面；通知 Queue 与周期流量快照均为可选且默认关闭的本地 P1 能力，尚未改变线上行为。

## P1 实施状态

- [x] Session 基础：密码登录创建随机设备会话，JWT 绑定 `sid`，每次鉴权同时验证签名、期限和 D1 活动会话。
- [x] 会话列表：只返回认证方式、首次/最近 IP、User-Agent、创建/最近活动/过期时间、当前与在线状态，不保存或返回原始 JWT。
- [x] 跨设备撤销：管理员可撤销其他活动会话，被撤销 JWT 下一次请求立即返回 401，当前会话保持可用；操作写入 `admin.session.revoke` 审计。
- [x] 活跃时间最多每分钟落库一次，非关键 touch 写失败不会把有效鉴权误报为 401；过期或撤销满 30 天的记录由 UTC 午夜 Cron 清理。
- [x] Session refresh 使用 D1 原子批处理轮换 `sid` 与 JWT，旧 JWT 立即失效；当前设备服务端退出会撤销会话，两类操作均写入不含令牌的审计事件。
- [x] 独立 Session 管理 Tab 按需加载，展示脱敏设备元数据、当前/在线状态，支持当前令牌轮换和跨设备确认撤销；JWT 按 API base 隔离，切换站点时会丢弃过期响应。
- [x] TOTP 2FA：RFC 6238 / SHA-1 / 30 秒窗口，secret 使用独立 Cloudflare Secret 派生的 AES-GCM 密钥加密保存；支持 setup/confirm/disable 和 10 个一次性恢复码。
- [x] TOTP 同时保护密码登录、setup 确认、站点公开性等关键设置和停用 2FA；登录按 IP、已登录操作按管理员身份共享独立的 D1 原子失败预算，五分钟内连续 5 次失败后限流。并发确认只允许一个请求消费 pending setup，初始密钥与唯一一套有效恢复码仅在创建时显示，D1、设置读取和审计均不回显。
- [x] 管理端支持身份验证器/恢复码登录、手动配置 URI、一次性恢复码确认和停用流程；未配置 `TOTP_ENCRYPTION_KEY` 时拒绝启用，不使用不安全回退。
- [x] GitHub OAuth：固定 exact callback、5 分钟 state、S256 PKCE、numeric GitHub ID 绑定、60 秒一次性交换码、TOTP/恢复码二次验证、绑定/解绑和 OAuth Session 撤销均已接通；密码登录保持应急可用。
- [x] OAuth access token 只在 callback 内存中使用；D1 仅保存 state/交换码哈希，不保存原始 state、PKCE verifier、GitHub token 或 Client Secret。匿名 start 按 IP 限制为五分钟 5 次且限流表只存哈希，GitHub token 与 `/user` 请求均有 10 秒超时；失败审计按事件、原因、IP 和五分钟窗口聚合，单组最多写 20 次。多站点前端会先清除 fragment，再按精确 `oauth_api` 将 JWT 保存到对应 API base。
- [x] 通用 PingTask：管理端支持 ICMP/TCP/HTTP CRUD、排序、新节点默认应用和最多 10 个启用任务/节点；停用默认任务不占启用容量，任务总量上限 100，最短间隔 60 秒，默认 300 秒。
- [x] schema 6 Agent 配置：旧 schema 3/4/5 不接收任务字段；schema 6 通过 URL-encoded JSON 下发任务，HTTP 与 WSS 均支持配置变更。
- [x] Agent 本地调度：新任务与配置变化任务立即执行，最多 4 并发；结果队列最多 100 条，每包最多回传 20 条，HTTP 2xx 或带匹配批次 ID 的 WSS 服务端 ACK 后才确认移除。
- [x] PingTask 结果：只接收仍启用且分配给该节点的任务，重复结果幂等；失败仅保存成功位与空延迟，不保存响应正文、Header 或原始错误；保留 7 天。
- [x] 前端：管理页可查看 24 小时摘要；节点详情页通过一次聚合请求显示该节点全部通用探测的成功率、平均延迟、最近状态和折线图；每任务只取时间范围内最新 2048 点。
- [x] 免费额度：结果表采用复合主键 `WITHOUT ROWID` 且不建立二级索引，避免每条结果产生额外索引写；历史查询按主键范围读取并限制每任务结果数；60 秒间隔仍属于高消耗配置，应以 D1 每日用量面板为准。
- [x] 配置逻辑备份：管理员可下载带版本、记录计数和 SHA-256 manifest 的 JSON；显式白名单包含非凭据设置、外观、服务器和 PingTask 配置，排除指标、结果、Session、审计、OAuth/TOTP 状态及已知凭据。
- [x] 可选私有 R2：存在 `BACKUP_BUCKET` binding 时可手动保存同一份有界 JSON；未绑定时安全降级且不影响 Worker。服务器、分配关系和产物分别限制为 5000、50000 和 1 MiB，不提供自动恢复。
- [x] 通知 Queue：存在 `NOTIFICATION_QUEUE` binding 时，离线、恢复、资源、到期告警和周期流量快照写入 D1 outbox，再向 Queue 发送只含版本与 job ID 的消息；管理员测试通知继续同步返回真实结果。
- [x] Queue consumer：逐条 claim、逐条 `ack()` / `retry()`；Provider 每次 Queue 尝试只调用一次，瞬时错误按 60/120/240 秒退避，初始投递加 3 次重试后写最终失败；永久配置错误不重试。
- [x] Queue 兼容与幂等：未绑定、消息超过 16 KiB UTF-8、写入或入队失败时走同步兼容路径；staged outbox 由 Cron 恢复，完成状态与最终投递记录通过 D1 batch 原子落库，任务保留 30 天。
- [x] 周期流量快照：管理端可选关闭/每日/每周/每月；按 UTC 周期键幂等，最多展开 50 台服务器，发送各服务器当前账期累计值、配额百分比和总量；默认关闭。
- [x] 流量口径明确：每台服务器可有不同重置日，且精确历史只保留 7 天，因此不把快照误写成自然日/周/月增量；Queue staged/queued/delivered/failed 状态会同步回报告运行记录，记录保留 400 天。
- [x] 使用独立 Secret 的完整 D1 REST export + Workflows 归档已在 `ops/d1-backup-workflow` 本地实现为隔离组件，不注入当前面板 Worker；默认 HTTP 404、流式写私有 R2、生成无 Secret manifest 且不自动恢复。

Session 工作包为 53 项 Node 测试通过，生产构建和 Wrangler dry-run 通过，现已部署。升级后旧的无 `sid` JWT 会失效；旧前端单值 Token 会一次性迁移到当前选定站点。

TOTP 工作包将全量测试扩展到 55 项；代码与界面已部署，但没有创建或写入线上 `TOTP_ENCRYPTION_KEY`，因此 TOTP 仍未启用。

GitHub OAuth 工作包将全量测试扩展到 62 项；生产构建、Agent 配置测试、`npm audit --audit-level=high` 与 Wrangler dry-run 均通过，代码已部署。当前没有创建 GitHub OAuth App，也没有配置 Client ID、callback URL 或 `GITHUB_OAUTH_CLIENT_SECRET`，因此入口保持不可用。

PingTask 工作包全量门禁：Worker 71 项 Node 测试、独立 Agent 配置测试、前端生产构建、`npm audit --audit-level=high`（0 漏洞）和 Wrangler `deploy --dry-run` 全部通过；Agent 119 项 Go 测试、`go test -race ./internal/cfprobe`、`go vet ./...` 全部通过。两个仓库的 `git diff --check` 均通过。工作包已部署，当前未创建 PingTask，真实 Agent HTTP 指标上报保持正常。当前不兼容 Komari Agent 协议，也不增加 traceroute、NextTrace、MeshTrace、iperf、Shell 或任意远程命令。

配置逻辑备份工作包全量门禁：Worker 72 项 Node 测试、独立 Agent 配置测试、前端生产构建、`npm audit --audit-level=high`（0 漏洞）、Wrangler `deploy --dry-run`、GitHub Actions YAML/内嵌 shell 语法和 `git diff --check` 全部通过。工作包已部署；线上实际导出 3150 字节 JSON，SHA-256 复算一致，未认证 401 和 R2 未绑定 400 均符合契约。它不是完整 D1 快照：D1 Time Travel 继续负责短期原地回滚，`wrangler d1 export` 继续负责受控的完整 SQL 导出；Cloudflare 2026 官方 D1 REST export + Workflows 示例在该检查点后置为独立组件，现已按下文状态完成并随 `58aa764` 推送，但尚未部署，Token 仍不进入面板 Worker。

通知 Queue 工作包已部署并启用：专用 Queue `cf-server-monitor-komari-notifications` 同时绑定 producer/consumer，Queue 消息不含 Provider Token、Chat ID 或通知正文；consumer 每条消息独立处理，同一 D1 job 共享四次持久化尝试总预算，重复物理消息不会重置计数。不存在 job ID 的无害探测已正常消费，验收后 `notification_jobs` 为 0。外部 Provider 边界仍是 at-least-once。

周期流量快照工作包代码已部署，线上设置为 `off`，不会自动发通知；`traffic_report_runs` 为 0。启用时仍需要现有通知凭据，并须单独核验通知与 Queue 配额。

隔离 D1 全量备份 Workflow 工作包已完成并随提交 `58aa764` 推送：独立配置与 Secret、D1 REST polling、新旧完成响应兼容、401/403 永久失败、429/5xx/网络重试、稳定 UTC/instance R2 key、SQL 流式直传、R2 条件写、无 Token/database ID/signed URL manifest、私有 bucket/生命周期/状态/下载校验/新库恢复手册均已落地。子项目 13 项 Node 测试和 Wrangler 4.124.0 dry-run 通过；当前没有创建 R2、API Token、Secret 或 Workflow，也尚未部署。

三个工作包合并后的最终门禁：主 Worker 94 项 Node 测试、隔离备份组件 13 项 Node 测试、独立 Agent 配置测试、前端生产构建、主/子项目两套 `npm audit --audit-level=high`（均 0 漏洞）、主 Worker 无 Queue 与启用 Queue 两套 Wrangler dry-run、隔离 Workflow Wrangler 4.124.0 dry-run、GitHub Actions YAML 与 6 段内嵌 shell 语法、`git diff --check` 全部通过。全部改动已在提交 `58aa764a6ed3a8037e8afee6f7794cbabd171920` 中提交并推送；该提交当时尚未创建远端 Queue/R2/API Token/Secret/Workflow。通知 Queue 已于 2026-08-22 单独部署验收，R2/API Token/Secret/Workflow 仍未创建。

## 明确不做

- WebSSH、远程 shell、远程命令和反向主控通道。
- GPU 温度、逐卡显存总量/占用及其 Agent 探测、历史表和图表；保留现有多 GPU 利用率历史，不扩展硬件传感器范围。
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
- [x] 已建立首个 Worker/D1/DO 实际用量基线；2026-08-19 完整 UTC 日中 Worker 请求、D1 写入、D1 读取、DO 请求和 DO duration 分别占 Free 日额度约 2.933%、1.500%、0.294%、1.607% 和 0.041%，详见 [`usage-baseline-2026-08-20.md`](usage-baseline-2026-08-20.md)。

第一阶段开发验收已全部完成。扩容节点或启用高频 PingTask 不属于当前开发完成条件；执行这类运维动作前，仍必须按基线文档连续观察至少 7 个完整 UTC 日，并确认单日峰值、异常状态和增长趋势满足门禁。
