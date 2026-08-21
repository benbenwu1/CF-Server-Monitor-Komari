# P2 推进优先级（2026-08-20）

> 结论日期：2026-08-20。本文只使用 Cloudflare 官方文档、官方价格/限制/Changelog，以及当前仓库源码和 `docs/`。GPU 温度与逐卡显存按用户明确要求永久排除：不推荐、不试点、不排期。

## 结论

当前 P0/P1 开发已经收口；通知 Queue 和周期流量快照代码已部署但保持未绑定/关闭，隔离 D1 备份 Workflow 仍未部署。P2 不应同时铺开多个 Cloudflare 新产品；建议先做两个低风险增量，再以真实需求触发实验。

四档排序如下：

1. **近期推进**：节点静态信息补齐；Analytics Engine 影子遥测。
2. **条件试点**：Browser Run 低频网页检查；Secrets Store 共享密钥治理。
3. **后置**：复杂 Workflows、R2 Data Catalog + R2 SQL、单指标 retention、AutoDiscovery key、受限主题扩展。
4. **排除**：GPU 温度与逐卡显存、traceroute/mesh、第三方 GeoIP Provider 矩阵、原始访客审计、主题包控制的 raw HTML/redirect/任意 head/body 注入能力。

## 评估基线

- 当前历史是 D1 宽表：一个 `metrics_history` 行同时保存 CPU、内存、磁盘、网络、GPU、静态字段等；每周轮换当前表和旧表，公开查询最多 168 小时。参见 [`src/database/schema.js`](../src/database/schema.js) 和 [`docs/capability-roadmap-2026.md`](capability-roadmap-2026.md)。
- 2026-08-19 完整 UTC 日中，D1 读取约占 Free 额度 0.294%，写入约占 1.500%，当前没有因容量必须迁移存储的压力。参见 [`usage-baseline-2026-08-20.md`](usage-baseline-2026-08-20.md)。Cloudflare D1 Free 当前为每天 500 万行读取、10 万行写入、账户总计 5 GB；列数和行大小不改变“行数”计费，但索引会增加写入。[D1 官方价格](https://developers.cloudflare.com/d1/platform/pricing/)
- P2 的默认安全边界继续沿用 P0/P1：不引入远程命令、任意脚本、公开备份、无界目标探测或长期保存原始访客身份数据。

## 第一档：近期推进

### 1. 节点静态信息补齐

**结论：已推进，本地实现完成，待提交、部署和真实 Agent 验收。**

- 用户价值：补齐内核、虚拟化、物理/逻辑核心等字段，可直接改善节点识别、资产盘点和故障上下文；当前已有 `cpu_cores`、`cpu_info`、`arch`、`os`、`kernel_version`、`region`、IPv4/IPv6，属于协议小步扩展，不需要新 Cloudflare 产品。
- Free 额度：静态字段应只在变化或低频心跳时更新；D1 按行读写计费，给现有行增加少量字段不会增加行数计费。[D1 官方价格](https://developers.cloudflare.com/d1/platform/pricing/)
- 架构耦合：需要 Agent、上报 schema、D1 migration、展示层同步升级，但不改变实时指标主链路。
- 安全边界：公开 API 只返回必要字段；公网 IP、虚拟化宿主细节等应允许隐藏。Cloudflare 的 `request.cf` 可提供入站连接的国家、地区、ASN 等信息，但它描述的是请求来源，不应覆盖 Agent 自报的节点事实。[Workers Request `cf` 官方文档](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties)
- 最小范围：先补 `kernel_version` 的端到端一致性、虚拟化类型、物理/逻辑核心；不夹带硬件序列号、MAC、完整网卡地址或 GPU 新指标。

### 2. Analytics Engine 影子遥测

**结论：已推进为可选影子遥测，本地实现完成；不替代 D1。**

- 用户价值：适合记录 CFSM 自身请求、告警、通知投递、PingTask 成功率和耗时分布，为容量趋势和产品运维提供 3 个月聚合视图；可减少为了统计而扫描 D1 业务表。
- Free 额度：Workers Free 每天包含 100,000 个写入点和 10,000 次 SQL 查询；每次 Worker invocation 最多写 250 点，数据保留 3 个月。[官方价格](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) · [官方限制](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- 架构耦合：增加一个可选 binding 和独立查询接口即可；写失败必须 best-effort，不得影响上报、告警或登录主流程。
- 数据正确性：Analytics Engine 会在写入和查询阶段自适应采样，不保证找回单条事件，也不适合审计、Session、通知 outbox 或精确账单。[官方采样说明](https://developers.cloudflare.com/analytics/analytics-engine/sampling/)
- 最小范围：首期只记录匿名聚合维度；index 采用稳定低基数值，不使用请求 UUID、完整 IP、URL 查询串、Server Secret 或通知凭据。
- 启动门槛：先以 shadow 模式运行 14 天，对比 D1/Cloudflare GraphQL 现有统计；准确性和写入预算达标后再增加后台图表。

## 第二档：条件试点

### 3. Browser Run 低频网页检查

**结论：值得试点，但必须是独立任务类型，不能把现有 HTTP PingTask 静默升级成浏览器任务。**

- 用户价值：可验证 JavaScript 渲染后的页面、关键文本和截图，覆盖普通 HTTP 状态检查发现不了的前端故障。
- Free 额度：Workers Free 每天 10 分钟浏览器时长；Browser Sessions 最多 3 个并发、新实例每 20 秒 1 个；Quick Actions 最多每 10 秒 1 次；默认空闲超时 60 秒。[官方价格](https://developers.cloudflare.com/browser-run/pricing/) · [官方限制](https://developers.cloudflare.com/browser-run/limits/)
- 架构耦合：需要新任务表、结果模型、截图 R2 生命周期、调度和通知；不应写入现有 `ping_task_results` 的简单 latency/status 结构。
- 安全风险：任意 URL 浏览器是 SSRF、内容抓取和额度耗尽入口。首期只允许管理员配置的 HTTPS 公网 origin allowlist；禁止私网、localhost、凭据 URL、Cookie 注入、任意脚本和登录自动化。
- 最小试点：最多 3 个目标，每目标每天 2–4 次；只做 `content`/`screenshot`/文本断言；截图私有保存 7 天；按 `X-Browser-Ms-Used` 记录实际耗时并设置每日熔断。
- 启动门槛：只有出现“HTTP 200 但页面实际不可用”的真实需求，且 P1 Queue/备份资源完成部署验收后再做。

### 4. Secrets Store

**结论：条件迁移，不作为独立用户功能。**

- 用户价值：当主 Worker、备份 Workflow、未来 Browser Run/报表 Worker 共享更多 Provider 密钥时，可集中轮换、按角色分离管理和部署权限。
- 产品状态：Secrets Store 目前是 open beta，官方明确支持 Workers 和 AI Gateway；当前官方目录没有单独公布可据以承诺的 Free 数量/调用额度，因此本路线图不假定“无限免费”。[官方概览](https://developers.cloudflare.com/secrets-store/)
- 架构耦合：绑定后的读取改为异步 `get()`；CI/CD 部署带 Secrets Store binding 时，部署 Token 需要 `Account Secrets Store Edit`，权限面比普通 Worker 部署更敏感。[Workers 集成](https://developers.cloudflare.com/secrets-store/integrations/workers/) · [访问控制](https://developers.cloudflare.com/secrets-store/access-control/)
- 安全判断：当前 Worker Secret 已能加密保存单 Worker 密钥。[Workers Secrets 官方文档](https://developers.cloudflare.com/workers/configuration/secrets/) 因此在只有少量独立 Secret 时，迁移收益不足以抵消 beta 与部署权限变化。
- 启动门槛：至少 3 个 Worker/Workflow 组件需要共享或统一轮换 5 个以上 Secret，且能为 CI 单独签发最小权限 Token；迁移需逐 Secret 验证，不做一次性全量切换。

## 第三档：后置

### 5. 复杂 Workflows 编排

**结论：后置为实现工具，不单独立项。**

- P1 已用独立 Workflow 完成 D1 全量备份；P2 只有在 Browser Run 诊断、长等待重试、人工确认或多阶段报告出现真实流程时才需要继续扩展。
- Workers Free 包含每天 3,000 steps；请求与 Workers 每天 100,000 次共享，Free 每 step 10 ms CPU、每实例最多 1,024 steps、100 MB 持久状态，完成状态默认保留 3 天。[官方价格](https://developers.cloudflare.com/workflows/reference/pricing/) · [官方限制](https://developers.cloudflare.com/workflows/reference/limits/)
- 不应用 Workflows 包装普通 CRUD、单次通知或普通 PingTask；否则增加状态、重试和排障面，却没有用户收益。

### 6. R2 Data Catalog + R2 SQL

**结论：后置到真正形成 Parquet/Iceberg 冷历史之后。**

- 当前只有约 1 MiB D1、7 天宽表历史和 SQL 备份对象，没有 Parquet/Iceberg ingest、分区、schema evolution 或 compaction 链路；现在引入属于架构超前。
- R2 Data Catalog 仍是 public beta，并要求 R2 subscription。每月包含 100 万 catalog operations、10 GB compaction 数据和 100 万 compaction objects；标准 R2 存储/操作另计。[官方概览](https://developers.cloudflare.com/r2-data-catalog/) · [官方价格](https://developers.cloudflare.com/r2-data-catalog/platform/pricing/) · [R2 官方价格](https://developers.cloudflare.com/r2/pricing/)
- R2 SQL 每月包含 10 GB 扫描量，之后 $0.0025/GB；每次查询最低按 10 MB 计，只读且仅查询 R2 Data Catalog 中的 Parquet/Iceberg 数据。[官方价格](https://developers.cloudflare.com/r2-sql/platform/pricing/) · [限制与最佳实践](https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/)
- 启动门槛：历史数据达到数十 GB、D1 读取或存储持续逼近门禁、确有 30–365 天跨节点分析需求，并先完成可回放的列式 ingest PoC。

### 7. 单指标 retention

**结论：原方案后置；如重启，应改成“指标组分层”，不做任意单指标开关。**

- 当前每条宽表记录同时包含全部指标，删除某一指标的历史不能减少行数；要实现真正的单指标 retention，必须拆表、列式冷存储或建立 rollup，耦合远高于管理界面增加一个天数输入框。
- 当前 D1 用量远低于 Free 门限，没有容量收益驱动。[D1 官方价格](https://developers.cloudflare.com/d1/platform/pricing/)
- 可接受的未来形态：高频核心指标 7 天、低频汇总 30/90 天、事件型数据独立 retention；先做迁移与回滚设计，再讨论 UI。

### 8. AutoDiscovery key

**结论：后置；拒绝长期共享的全局注册 key。**

- 用户价值只在批量纳管大量节点时明显；当前逐节点 ID/Secret 更容易撤销和审计。
- 静态全局 key 泄露后会允许持续注册垃圾节点，扩大 D1 写入、通知和 Agent 信任面。
- 如真实需要，设计为短时、一次性、限数量、限来源的 enrollment token，注册后立即换成每节点 Secret；Token 只能放 Worker Secret 或 Secrets Store，不能进入普通 `vars`。[Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [Secrets Store 访问控制](https://developers.cloudflare.com/secrets-store/access-control/)
- 启动门槛：有可量化的批量部署需求，例如单次纳管 20 台以上，并先定义撤销、配额、审计和重复注册策略。

### 9. 受限主题扩展

**结论：后置；只保留 schema 驱动的安全配置。**

- 当前已有内置主题、远程 GitHub tree 主题、预览、`theme_options`，以及管理员控制的 `favicon`、`custom_head`、`custom_script`；这些现有能力不需要重新列为 P2。继续复制 Komari 的完整主题运行模型不是核心监控价值。
- 可接受范围：颜色、字体、布局、文案和已知组件开关；所有字段白名单化、版本化、可回滚。
- CSP 变更必须先在测试环境验证，第三方脚本和连接目标会扩大前端供应链风险。[Cloudflare CSP 官方说明](https://developers.cloudflare.com/web-analytics/faq/#what-do-i-need-to-add-to-my-content-security-policy-csp)
- 不接受由第三方主题包控制的 raw HTML、redirect、任意 JavaScript 或任意 head/body 注入；现有管理员自定义字段继续按 CSP、审计和站点权限边界维护，不扩大给主题作者。

## 第四档：排除

### 10. GPU 温度与逐卡显存

**结论：永久排除。不得推荐、试点或排期。**

- 这是用户明确边界。
- 能力必须由各操作系统 Agent 和驱动采集，Cloudflare Worker 只接收上报，不提供宿主 GPU 硬件访问；引入它会扩大 Agent 平台矩阵、协议、历史、图表和测试面。[Workers 运行模型](https://developers.cloudflare.com/workers/reference/how-workers-works/)
- 当前已有多 GPU 利用率历史，保持现状即可。

### 11. traceroute / NextTrace / mesh

**结论：排除当前 P2。只有未来出现明确故障诊断需求时，另开独立 RFC，不能复用 PingTask 的协议预留直接实现。**

- 当前 PingTask 已覆盖 ICMP/TCP/HTTP；traceroute/mesh 需要 Agent 权限、平台差异、目标滥用控制、结果拓扑模型和显著更多写入。
- Workers 官方提供的是 outbound TCP `connect()`，并受连接数、目标和子请求限制；它不是 raw ICMP/UDP traceroute runtime。[TCP Sockets 官方文档](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) · [Workers 官方限制](https://developers.cloudflare.com/workers/platform/limits/)
- Mesh 会产生节点平方级任务关系，不符合当前 Free 额度与单向上报安全模型。

### 12. 第三方 GeoIP Provider 矩阵

**结论：排除。**

- Cloudflare 已在所有计划向入站 Worker 请求提供 country、city、region、ASN、经纬度等 `request.cf` 信息，并持续更新 IP 地理库。[Workers Request 官方文档](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties) · [IP Geolocation 官方文档](https://developers.cloudflare.com/network/ip-geolocation/)
- 当前节点地区已能由 Agent/管理员语义控制。再接入 ipinfo、ip-api、geojs、MMDB Provider 管理只会增加隐私外发、Provider Secret、限流、失败降级和数据冲突。
- 若节点处于代理后方，第三方 GeoIP 同样不能自动恢复“真实物理位置”；保留人工覆盖比 Provider 矩阵更可靠。

### 13. 原始访客审计

**结论：排除保存 path + IP + UA 的全量访客日志；如只需趋势，使用匿名聚合。**

- 原始访客审计会把每次公开读取变成 D1 写入，带来隐私、retention、导出和访问控制负担，且与当前只审计登录和高价值管理写操作的边界冲突。
- Workers Free Logs 已包含每天 200,000 个 log events、3 天保留，可用于短期排障；长期趋势应写 Analytics Engine 的匿名聚合，不保存完整 IP、UA 或查询串。[Workers Logs 官方价格](https://developers.cloudflare.com/workers/platform/pricing/#workers-logs) · [Analytics Engine 官方价格](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)

### 14. 主题包 raw HTML / redirect / 任意 head/body 注入

**结论：排除。**

- 这类能力等价于给第三方主题作者持久 XSS、外部跳转或任意脚本入口，会削弱当前 CSP、管理员界面隔离和远程主题 allowlist。当前由管理员直接控制的 `custom_head`、`custom_script` 和 `favicon` 不在本排除项内，但不得自动下放给主题包。
- Cloudflare 官方也要求 CSP 变更先在测试环境验证，并明确配置允许的脚本和连接来源。[CSP 官方说明](https://developers.cloudflare.com/web-analytics/faq/#what-do-i-need-to-add-to-my-content-security-policy-csp)
- 主题扩展只允许第三档中的 schema 驱动配置，不建立通用运行时。

## 建议实施顺序

1. 先部署并验收已经完成的 P1 Queue、周期流量快照和隔离备份 Workflow；这不是 P2 代码任务，但它们是观察新增用量和故障面的前提。
2. P2.1：Worker 端和 Agent RC2 已部署到单一测试节点，物理核心与 `kvm/guest` 实机验证通过；待决定是否发布正式 Agent patch 版本。
3. P2.2：Analytics Engine shadow telemetry 代码已部署但 binding 关闭；待单独授权启用后运行 14 天，再决定是否建设后台图表。
4. P2.3：仅在真实网页故障需求出现后，做 Browser Run 小规模试点。
5. Secrets Store 只在组件和共享 Secret 达到门槛时迁移。
6. 第三档项目在各自启动门槛满足前保持文档状态；第四档不得进入开发排期。

## 最终推荐

真正值得进入下一轮设计的是 **节点静态信息补齐** 和 **Analytics Engine 影子遥测**。Browser Run 有明确差异价值，但应由真实网页监控需求触发受限试点。其余 Cloudflare 产品与 Komari 细项目前要么缺少数据规模前提，要么安全/耦合成本高于收益。GPU 温度与逐卡显存以及第四档其他能力明确不进入路线图。
