# Cloudflare 免费平台能力核验（2026）

> 核验日期：2026-08-19（Asia/Shanghai）。本文只采用 Cloudflare 官方文档、价格页、限制页和 changelog；所有额度均可能继续变化，实施前应再次检查链接中的当前值。

## 结论先行

这个项目继续采用 Workers + D1 + Durable Objects + Static Assets 是合理的，但免费层真正需要控制的不是前端流量，而是三个计量面：

1. **D1 每日写入行数**：免费层为 100,000 rows written/day，是长期指标历史最先遇到的硬约束。
2. **Durable Objects duration**：Agent 使用标准 WebSocket 时对象不能休眠；20:1 只减少 incoming message 的请求计量，不会消除长连接 duration。
3. **Workers 动态请求和 CPU**：100,000 requests/day、每次 10 ms CPU，要求管理操作、告警和导出继续做成低频路径。

2025–2026 年免费层新增的 Durable Objects、Queues 和 Workflows 确实扩大了可实现范围。对本项目最有价值的新增组合是：

- Queues：通知重试、Webhook 去耦、异步导出。
- Workflows：低频多步骤备份、周期报告、网络诊断编排。
- R2：备份、审计归档和历史冷数据。
- Workers Logs / Traces：平台级调试与短期运维观测。

它们都不适合替代 D1 的分钟级指标写入主链路。

## 官方免费额度矩阵

| 产品 | 免费层或最低计划当前额度与限制 | 对 CFSM 的意义 | 决策 |
| --- | --- | --- | --- |
| Workers | 100,000 动态请求/天；每次 10 ms CPU；128 MB；每请求 50 个外部 subrequests；每账户 5 个 Cron、100 个 Worker | 足够承载小规模面板和 API；复杂聚合、批量网络请求必须拆分或异步化 | 保持现有主运行时 |
| Static Assets | 每个版本 20,000 个文件；单文件 25 MiB；普通静态资源请求免费且不限量 | Vue 前端不会侵占 100,000 动态请求预算 | 保持现有部署方式 |
| D1 | 5M rows read/天；100k rows written/天；总存储 5 GB；10 个数据库；单库 500 MB；Time Travel 7 天；每次 Free Worker 调用最多 50 个查询 | 指标历史的核心约束是每日写行，不是 5 GB 总容量 | 保留；优先控制写放大和查询读放大 |
| Durable Objects | 100k requests/天；13,000 GB-s duration/天；Free 只能使用 SQLite-backed DO；SQLite 存储为 5M rows read、100k rows written、5 GB | 实时广播可用；标准 Agent WebSocket 会持续产生 duration | 保留；前端用 Hibernation，Agent WSS 默认按需开启 |
| Queues | 2026-02-04 起进入 Free；10,000 operations/天；最多 10,000 queues；消息保留固定 24 小时 | 适合少量通知、导出、Webhook 重试；一次正常投递通常约 3 次 operation | P1，用于控制面异步任务，不中转每个指标包 |
| Workflows | 与 Workers 共用 100k requests/天；每步 10 ms CPU；3,000 steps/天；1 GB-month 状态；单实例 100 MB；Free 每实例最多 1,024 steps；100 个运行中实例；完成状态保留 3 天；`step.sleep` 最长一年 | 很适合低频、可恢复的多步骤任务；Free 不收 steps/storage 超额费，但存储到达上限会报错 | P2，先用于备份/报告试验 |
| Workers KV | 100k reads/天；1,000 writes/天；1,000 deletes/天；1,000 list/天；1 GB | 适合低频配置、幂等键和缓存，不适合指标历史 | 有明确缓存需求时再引入 |
| R2 | 10 GB-month/月；1M Class A/月；10M Class B/月；公网 egress 免费；免费额度只适用于 Standard storage | 适合备份 ZIP/JSON/SQL、审计归档、主题快照 | P1，先做可选备份目标 |
| R2 Data Catalog | 需启用 R2 subscription；1M catalog operations/月；compaction 包含 10 GB 数据和 1M objects/月，另计普通 R2 费用 | 面向 Apache Iceberg 数据湖，不是 D1 备份或普通 R2 JSON 的目录服务 | P2 观察，不进入近期路线 |
| R2 SQL | 需启用 R2 subscription；所有计划含 10 GB compressed data scanned/月；每次查询最低计 10 MB，另计 R2 与 Data Catalog 操作 | 只能查询 R2 Data Catalog 中的 Iceberg 表，不能直接查询 D1 或普通 R2 对象 | P2 观察，不替代 D1 |
| Pipelines | open beta，仅 Workers Paid 可用；ingress 免费；Paid 每月含 50 GB SQL transforms 和 50 GB sinks，写 R2/Data Catalog 另计费 | 可把事件流转成 JSON/Parquet/Iceberg，但不是 Workers Free 能力，且当前规模没有收益 | 不采用 |
| Analytics Engine | 100k data points/天；10k read queries/天；每次调用最多写 250 points；每点最多 20 blobs、20 doubles、1 index；保留 3 个月 | 适合高基数聚合遥测和 CFSM 自身用量统计，不是精确历史数据库 | P2 实验，不替换 D1 |
| Browser Run | 10 浏览器分钟/天；3 个并发浏览器；Free 超额无按量扩展 | 可做低频网页可用性检查、截图或内容验证 | P2，仅低频任务 |
| Turnstile | 免费；每账户最多 20 widgets；每 widget 10 hostnames；challenge/verification 不限量；Analytics 回看 7 天 | 当前登录防护已经受益 | 继续保留 |
| Workers Logs | 200k log events/天；保留 3 天 | 适合 Worker/DO/D1 故障定位，不是产品审计日志 | P0 补齐运维说明和采样策略 |
| Workers Traces | 初始 beta 期间免费；2026-10-01 起每个 span 作为一个 observability event，与 Logs 共用 200k/天、3 天保留 | 可定位请求跨 Worker/DO/D1 的慢点；必须控制采样 | P0 配置，默认低采样 |
| Secrets Store | Open beta；当前每账户 1 个 Store；最多 100 secrets；可绑定 Workers | 多 Worker、多 Provider 时有价值；单 Worker 当前收益有限 | P2，暂不迁移现有 Secret |
| Hyperdrive | 100,000 database statements/天；连接外部 PostgreSQL/MySQL | 能模仿 Komari 的外部数据库，但会引入新的运维和故障域 | 不为“对齐上游”而引入 |
| Email Service | 入站 Email Routing 不限量；Free 不能向任意收件人发信；只可免费发往账户内 verified destination addresses | 不能当作通用免费告警渠道 | 继续以 Webhook、Telegram、Bark 等为主 |

## 关键计量解释

### Workers 与 Static Assets

[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) 给出的 Free 上限是 100,000 requests/day、10 ms CPU、128 MB、5 个 Cron Trigger、100 个 Worker、20,000 个静态文件和 25 MiB 单文件。普通 [Static Assets 请求免费且不限量](https://developers.cloudflare.com/workers/platform/pricing/)，所以前端页面、JS、CSS 和图标不应经过动态 API 逻辑。

2026-02-11 的 [subrequest changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/) 只提高了 Paid 默认值；Free 仍是每次调用 50 个外部 subrequests、对 Cloudflare 服务最多 1,000 个。因此通知广播或批量探测不能在一个请求中无界 fan-out。

### D1

[D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/) 的 Free 日额度是 5M rows read 和 100k rows written，总存储 5 GB。[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) 进一步限定 Free 为 10 个数据库、单库 500 MB、7 天 Time Travel，以及每次 Worker 调用 50 个 D1 查询。

若每个节点严格每分钟写一条历史记录，仅表记录本身就是 `1,440 × 节点数` rows/day；100,000 / 1,440 ≈ 69.4 只是**忽略索引、设置更新、告警状态和重试后的数学上限**，不能当成支持 69 个节点的产品承诺。D1 对索引维护也计 rows written，因此路线图必须优先考虑：

- 保持实时广播与历史持久化解耦。
- 不为审计或通知给每个指标样本追加额外写入。
- 历史表索引只保留能显著减少 rows read 的必要项。
- 报表按查询生成或写入粗粒度聚合，不能复制原始样本。

7 天 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) 能处理误删和短期回滚，但不是可下载、可跨账户恢复的备份；产品层仍应提供导出，并可选写入 R2。

### Durable Objects 与 WebSocket

[Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) 明确说明：

- 2025-04-07 起 [Durable Objects 可用于 Workers Free](https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/)，但 Free 只能使用 SQLite-backed DO。
- 一个 WebSocket 建连计一次请求；incoming application messages 按 20:1 折算；outgoing messages 和协议 ping 不计请求。
- 使用标准 `accept()` 的 WebSocket 在连接期间持续产生 wall-clock duration；只有 Hibernation API 能让空闲对象免除 duration。

当前 Fork 的前端订阅使用 Hibernation，而 Agent WSS 使用标准 WebSocket。后者即使 incoming messages 按 20:1 计量，也**不是零 duration**。现有 `wss_report_enabled=false` 的线上默认值合理：HTTP 是免费环境基线，WSS 是需要实时性时的显式选择。

### Queues

[Queues Free changelog](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/) 和 [Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/) 给出 10,000 operations/day 与 24 小时保留。一次成功消息通常包含 write、read、delete 三次 operation，因此粗略只有约 3,333 次完整投递/天；批处理不会把十条消息算成一次。

适合放入 Queue 的内容：

- 通知投递与指数退避重试。
- Webhook / 外部 API 的短暂故障隔离。
- 备份导出任务的触发消息。
- 低频网络探测结果的异步处理。

不适合放入 Queue 的内容：每个 Agent 的实时上报、每分钟历史样本、前端 WebSocket 广播。

### Workflows

[Workflows Pricing](https://developers.cloudflare.com/workflows/reference/pricing/) 自 2026-08-10 起计量 steps 和 storage；Free 为 3,000 steps/day 与 1 GB-month，官方 [billing changelog](https://developers.cloudflare.com/changelog/post/2026-07-07-workflows-billing-updates/) 只承诺 Free 不会对超出 included amounts 的 steps/storage 收费，不能据此推导为“可无限免费超额”。价格页明确说明：Free 达到 storage limit 后，继续保存状态的实例会抛错。对 steps 超量的执行行为，当前价格页没有给出同等明确的兜底承诺，因此本项目把 3,000 steps/day 作为设计硬预算，而不是可依赖的软额度。[Workflows Limits](https://developers.cloudflare.com/workflows/reference/limits/) 另规定 Free 单实例 100 MB、1,024 steps、100 个运行中实例、完成状态保留 3 天，`step.sleep` 最长一年。

它适合编排“导出 D1 → 校验 → 写 R2 → 通知”或“发起诊断 → 等 Agent → 聚合结果 → 通知”这类低频流程。每分钟执行的正常告警轮询和 D1 历史写入继续使用现有 Worker/Cron 更简单、更节省 steps。

Cloudflare 2026-06-02 已发布 [Export and save D1 database](https://developers.cloudflare.com/workflows/examples/backup-d1/) 官方示例：Workflow 调用 D1 REST export、轮询 signed URL，再把 SQL dump 流式写入 R2。它证明完整归档在 Free 可实现，但不改变权限边界：示例需要具有目标 D1 export 权限的 API Token，完整 SQL 也会包含当前 D1 中的凭据与运行数据。本项目先落地不需要该高权限 Token 的管理员脱敏配置 JSON；完整 Workflow 归档后置为独立组件。

### R2、Analytics Engine 与 Browser Run

[R2 Pricing](https://developers.cloudflare.com/r2/pricing/) 的免费额度足以保存小型监控站的导出包，而且公网 egress 免费。它应作为可选归档层，不放在指标上报的同步路径中。

[Analytics Engine Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) 当前仍说明尚未正式开始收费；公布的 Free 包含量为 100k data points/day、10k read queries/day。[Analytics Engine Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) 固定保留 3 个月，适合统计而非精确可恢复历史；SQL API 还需要账户级 Token，不能直接作为访客前端数据库。

[Browser Run 免费额度](https://developers.cloudflare.com/changelog/post/2025-07-28-br-pricing/) 只有每天 10 分钟和 3 并发。2026-04-15 产品从 Browser Rendering [更名为 Browser Run](https://developers.cloudflare.com/changelog/post/2026-04-15-br-rename/)。它适合一天数次的网页截图或内容检查，不适合分钟级 HTTP 监控。

### Pipelines、R2 Data Catalog 与 R2 SQL

[Pipelines 产品页](https://developers.cloudflare.com/pipelines/) 当前明确标注 open beta、仅 Workers Paid 可用；[Pipelines Pricing](https://developers.cloudflare.com/pipelines/platform/pricing/) 给 Paid 每月 50 GB SQL transforms 与 50 GB sinks，stream ingress 免费。2026-08-03 [Pipelines 开始计费](https://developers.cloudflare.com/changelog/post/2026-08-03-pipelines-billing-enabled/)，写入 R2 或 Iceberg 仍会叠加 R2 / Data Catalog 费用。因此它不是“免费用户新增能力”，也不进入本项目近期路线。

[R2 Data Catalog](https://developers.cloudflare.com/r2-data-catalog/) 是 R2 subscription 可用的 public beta Apache Iceberg catalog。[定价页](https://developers.cloudflare.com/r2-data-catalog/platform/pricing/) 每月包含 1M catalog operations；只有打开自动 compaction 时，才另有 10 GB processed data 与 1M processed objects 的月度包含量。2026-08-03 [Data Catalog 开始计费](https://developers.cloudflare.com/changelog/post/2026-08-03-r2-data-catalog-billing-enabled/)。

[R2 SQL](https://developers.cloudflare.com/r2-sql/) 是查询 Data Catalog Iceberg 表的 open beta 分析引擎，不会直接把普通 R2 JSON、备份 ZIP 或 D1 变成 SQL 表。[R2 SQL Pricing](https://developers.cloudflare.com/r2-sql/platform/pricing/) 对所有计划每月包含 10 GB compressed data scanned，每次查询至少按 10 MB 计量；2026-08-03 [R2 SQL 开始计费](https://developers.cloudflare.com/changelog/post/2026-08-03-r2-sql-billing-enabled/)。这套数据湖链路只有在冷历史规模、跨月分析和列式查询需求明显后才值得实验，当前测试站引入它会增加远高于收益的格式、目录和运维复杂度。

### 安全、可观测性和邮件

[Turnstile Free](https://developers.cloudflare.com/turnstile/plans/) 足够当前单站登录使用，继续保留。

[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) Free 有 200k events/day、3 天保留。[Workers Traces](https://developers.cloudflare.com/workers/observability/traces/) 在 2026-10-01 后每个 span 计为同一 observability event 配额。它们用于平台调试，不能替代 D1 中面向管理员的长期安全审计。

[Secrets Store](https://developers.cloudflare.com/secrets-store/) 仍是 Open beta；[2025-05 限额更新](https://developers.cloudflare.com/changelog/post/2025-05-19-paygo-updates/) 将上限提高到每账户 100 secrets。当前项目只有一个 Worker Secret，不值得为了“新功能”立即迁移；等通知 Provider 密钥增多或拆分多个 Worker 时再评估。

[Hyperdrive Pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) 虽已给 Free 100k statements/day，但它连接的是外部数据库，并不会让外部 PostgreSQL/MySQL 本身免费。CFSM 当前 D1 原生路线不需要它。

[Email Service Pricing](https://developers.cloudflare.com/email-service/platform/pricing/) 明确写明 Free 的 arbitrary-recipient outbound 不可用；只向账户内 verified destination addresses 发送才免费。因此邮件可以是自用通知选项，不能承诺为所有用户提供通用免费邮件告警。

## 分阶段采用建议

### P0：不新增平台绑定

- 校正用量面板中的 Workers、D1、DO 当前免费额度和计量说明。
- 为 Workers Logs 和 Traces 增加采样、脱敏与保留期运维文档。
- 用 D1 Time Travel + 手工导出形成最小恢复手册。
- 继续保持 Agent HTTP 默认、WSS 按需开启。

### P1：明确收益后新增绑定

- Queues：通知投递记录、失败重试、Webhook 去耦。
- R2：版本化 JSON/SQL 导出、备份清单和恢复校验。
- 可选 Workflows：使用独立最小权限 Token，把低频完整 D1 REST export 和周期报告做成可恢复步骤；不把该 Token 注入当前面板 Worker。

### P2：额度敏感或实验性质

- Analytics Engine：CFSM 自身运行遥测和高基数统计。
- Browser Run：低频网页可用性与截图检查。
- R2 Data Catalog + R2 SQL：只有形成大规模 Parquet/Iceberg 冷历史后再做数据湖实验。
- Secrets Store：多 Worker、多 Provider 后集中管理密钥。
- Workflows：复杂网络诊断任务编排。

## 明确不采用

- 不用 Queues 中转每个 Agent 指标包。
- 不用 Workflows 替代每分钟 Cron 或正常 D1 写入。
- 不用 Analytics Engine 替代精确历史和恢复数据库。
- 不把 Pipelines 当作 Workers Free 能力，也不为当前小规模指标流购买 Paid 后引入流处理链路。
- 不用 R2 SQL 直接查询普通 R2 备份；它只面向 Data Catalog 管理的 Iceberg 表。
- 不为模仿 Komari 的 MySQL/PostgreSQL 支持而引入 Hyperdrive。
- 不把 Cloudflare Email Service 宣传成任意收件人的免费告警通道。
