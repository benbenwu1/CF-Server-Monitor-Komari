# Komari 全能力对比与 CF 路线图（2026）

> 研究快照：2026-08-18。本文的目标是回答三个问题：Komari 当前真正成熟的能力有哪些；本 Fork 的源码和线上实例分别具备什么；哪些能力值得在 Cloudflare 免费架构上实现。

## 结论

当前 Fork 已经是一个可运行的 Cloudflare 原生监控产品，不需要也不应该重写成 Komari 的 Go 服务端。最值得借鉴的不是 WebSSH、插件或远程命令，而是以下控制面能力：

1. **P0：安全事件与管理审计**——登录成功/失败、关键写操作、明确 retention。
2. **P0：节点信息语义补齐**——内部备注/公开备注分离、补 `min` 流量算法。
3. **P0：通知可靠性**——结构化 Provider、投递结果、失败重试；先保持现有渠道兼容。
4. **P1：任意 PingTask**——这是 Komari 最有监控价值、且适合 CF 架构的差异能力，但需要扩展 `cfsm-agent` 协议。
5. **P1：Session、TOTP、OAuth/OIDC**——按安全收益分阶段引入，不一次性复制整套账户系统。
6. **P1：D1 导出 + R2 备份**——用 Cloudflare 原生恢复模型替代 Komari 的文件系统 ZIP 机制。

明确不进入路线图：WebSSH、远程命令、剪贴板、Komari Agent 协议兼容、服务端插件/JS runtime、任意用户脚本、child process、本地监听端口。

## 核验方法与状态口径

### 固定快照

| 对象 | 固定版本 | 用途 |
| --- | --- | --- |
| Komari | [`da4d518`](https://github.com/komari-monitor/komari/tree/da4d5187c1b10da3c5893595c5e2a9fd54d13792)，2026-08-17 | 功能参考与源码事实 |
| CF-Server-Monitor | [`a4911ff`](https://github.com/huilang-me/CF-Server-Monitor/tree/a4911ffa8664e047ea672d735a32d8ffde1c01da)，2026-08-15 | Fork 上游基线 |
| 当前 Fork | [`1662281`](https://github.com/benbenwu1/CF-Server-Monitor-Komari/tree/1662281220a9c96fe37c9906b28911d3c0fe1d63)，2026-08-18 | 本文“CF 源码”状态 |
| cfsm-agent | [`b435168`](https://github.com/huilang-me/cfsm-agent/tree/b435168ab8585aed10801d3e2918ba2fa09342b4) / `v1.0.8` | 当前探针协议与采集能力 |

### 三层状态

- **Komari 成熟**：模型、路由/RPC、调度或运行链路已接通，能作为产品能力使用。
- **Komari 部分/预留**：只有数据结构、方法常量或局部实现，不能按成熟功能宣传。
- **CF 源码**：当前 Fork 中存在完整或部分代码；不等于线上已配置。
- **CF 线上**：2026-08-18 通过 Cloudflare API、D1 只读 SQL 和真实浏览器/Agent 验证；“未启用”不代表源码缺失。

评分均为相对值：用户价值、实现复杂度、免费额度压力、安全风险均为 1（低）到 5（高）。优先级中的“保留”表示当前优势，“P0/P1/P2”表示候选阶段，“不做”表示超出产品安全边界或 Cloudflare 运行模型。

## Komari 能力全景

以下是矩阵之外需要保留的实现细节，避免把一个功能名误读成完整产品能力：

- **监控与存储**：指标库始终启用，未配置时使用 `./data/metrics.db`，也支持 MySQL/PostgreSQL。内建指标默认 retention 为 1 天，可按指标修改；0 表示停用持久化并异步删除数据。默认 exact raw 窗口 10 分钟，随后有 1 分钟桶保留 600 分钟、5 分钟桶保留 3,000 分钟、1 小时桶保留 600 小时、日桶最终按指标 retention 清理；聚合支持 TDigest 百分位。[K-Metric] [K-Rollup]
- **节点与计费**：节点模型同时包含内部 `Remark` 和公开 `PublicRemark`，以及价格、币种、计费周期、自动续费、到期日、分组、标签、隐藏、Agent Token 和 `sum/max/min/up/down` 五种流量口径。[K-Model]
- **Ping**：PingTask 是完整管理能力，支持 ICMP/TCP/HTTP、权重、间隔、指定节点、新节点默认应用、排序、Agent 拉取、结果上传和公开历史；NextTrace/iperf3/MeshTrace 与此不同，只是协议预留。[K-Ping] [K-NetProto]
- **通知与认证**：离线/恢复、到期/续费、流量阈值、负载、登录成功、通知模板和测试通知已经接通；Provider 为 Telegram、email、Bark、webhook、Server酱³、Server酱Turbo、Javascript 和 empty。认证支持密码、禁用密码、GitHub、QQ、generic OIDC、TOTP、外部账号绑定/解绑和设备 Session。[K-Notify] [K-Senders] [K-OAuth] [K-Session]
- **审计**：管理日志支持类型筛选和分页。访客审计默认关闭，记录 event/path/route/target/UA/detail、IP 与用户 UUID，并对每 IP 做 token-bucket 限流和字段长度约束。[K-Audit] [K-VisitorAudit]
- **主题**：支持安装、删除、启用、更新、导入和市场源；manifest 文本可多语言；主题可为 managed/raw HTML/redirect，managed 配置项包括 string、number、select、switch、title、textbox、richtext、nodes、pingtasks。[K-Router] [K-Theme]
- **插件与远程控制**：插件有安装、启停、配置、日志、市场和公开/管理页面，但其权限面包括系统 RPC、HTTP 路由、HTTP/WS hook、HTML 注入、child process、本地监听和全文件系统；另外还有 Web 终端、多节点命令与剪贴板。这些是长驻进程能力，不适合 Workers 安全模型。[K-Plugin] [K-Remote] [K-Router]
- **备份恢复**：下载使用 `VACUUM INTO` 生成一致性 SQLite 快照，并按白名单打包数据库、指标、主题和插件；归档同时保存在 `data/backup/`。恢复支持分片上传，只接受 ZIP，限制压缩包和展开总量为 4 GiB、最多 100,000 项并要求 marker；启动恢复前生成 `pre-restore` 快照，版本升级前也会自动归档。[K-Backup] [K-Restore] [K-DBCore]
- **管理员运维接口**：除备份外，Komari 还暴露主库/指标库大小与空间回收、表枚举、任意 SQL query/exec，以及受管理员鉴权保护的 CPU/trace/heap/goroutine 等 pprof 下载接口。这些是可调用的真实 API，但任意 SQL 与进程级诊断风险高，也依赖长驻 Go 进程，不能当作 Workers 产品移植项。[K-DBMaint] [K-DBRPC] [K-Pprof]

## 完整能力矩阵

### 指标、历史与节点

| 能力 | Komari 状态 | 当前 CF 源码 | 当前线上 | 价值 | 复杂 | 额度 | 风险 | Agent 改动 | 优先级 | 证据 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| CPU、RAM、swap、磁盘、网络、load、uptime | 成熟 | 完整 | 已真实上报 | 5 | 1 | 3 | 1 | 否 | 保留 | [K-Model] [C-Schema] [Live] |
| 磁盘 IO、进程、TCP/UDP 连接 | 成熟 | 完整；磁盘 IO 依平台 | 已真实上报/展示 | 4 | 1 | 3 | 1 | 否 | 保留 | [K-Model] [C-Agent] [Live] |
| 多 GPU 利用率历史 | 成熟 | 完整保存 `gpu_info` JSON，多卡曲线 | 测试节点无 GPU，未实机验 | 3 | 1 | 3 | 1 | 否 | 保留 | [K-GPU] [C-Schema] [C-Agent] |
| GPU 温度、逐卡显存总量/占用 | 成熟 | 缺失；当前 Agent 只有 `name/info/id` | 不存在 | 3 | 3 | 3 | 1 | 是 | P2 | [K-GPU] [C-Agent] |
| 节点静态信息：CPU、核心、虚拟化、OS、内核、架构、IP、地区 | 成熟 | 大部分有；物理核心/虚拟化语义较弱 | 已验证主要字段 | 4 | 2 | 1 | 2 | 可选 | P2 | [K-Model] [C-Agent] [Live] |
| 历史指标与查询 | 成熟，独立 metric store | 7 天 D1 历史、长时段抽样、播放 | 66 条，持续增长 | 5 | 2 | 5 | 1 | 否 | 保留 | [K-Rollup] [C-Schema] [Live] |
| raw + 1m/5m/1h/day rollup、TDigest 百分位 | 成熟 | 无同等 rollup；按查询窗口稀疏采样 | 不存在 | 3 | 5 | 5 | 1 | 否 | 不照搬 | [K-Rollup] [C-Sampling] |
| 单指标 retention 管理 | 成熟，可设为 0 清数据 | 站点统一 7 天，无单指标策略 | 不存在 | 3 | 4 | 4 | 2 | 否 | P2 | [K-Metric] [K-Rollup] [C-Schema] |
| SQLite / MySQL / PostgreSQL 指标后端与迁移 | 成熟 | 仅 D1 | D1 已绑定 | 2 | 5 | 5 | 3 | 否 | 不做 | [K-Metric] [Live] |
| 节点 CRUD、排序、分组、标签、隐藏 | 成熟 | 完整，另有批量删除和导入导出 | CRUD/排序/隐藏已验 | 5 | 1 | 1 | 2 | 否 | 保留 | [K-Router] [C-Admin] [Live] |
| 内部备注与公开备注分离 | 成熟 | 只有单一 `note` | 未分离 | 4 | 2 | 1 | 2 | 否 | P0 | [K-Model] [C-Schema] |
| 价格、币种、周期、自动续费、到期日 | 成熟 | 完整 | 字段和自动续期逻辑已部署 | 4 | 1 | 1 | 1 | 否 | 保留 | [K-Model] [C-Notify] |
| 流量限制算法 | 成熟：`sum/max/min/up/down` | `total/ul/dl/max`，等价四种，缺 `min` | 默认 `total` | 4 | 1 | 1 | 1 | 否 | P0 | [K-Model] [C-Traffic] [Live] |
| Agent Token 与自动发现注册 key | 成熟 | 每节点 ID/Secret；无 AutoDiscovery key | 独立测试 Secret 已用 | 3 | 3 | 2 | 3 | 是 | P2 | [K-Router] [C-Agent] [Live] |
| GeoIP Provider：ipinfo/ip-api/geojs/MMDB/empty | 成熟 | 主要依赖 Agent/Cloudflare 地区与前端旗帜 | 地区已显示；无 Provider 管理 | 2 | 3 | 2 | 2 | 可选 | P2 | [K-Settings] [C-Agent] |

### Ping 与网络诊断

| 能力 | Komari 状态 | 当前 CF 源码 | 当前线上 | 价值 | 复杂 | 额度 | 风险 | Agent 改动 | 优先级 | 证据 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| 固定电信/联通/移动与可选 BD 延迟、丢包 | 非同型；由通用 PingTask 覆盖 | 完整 | 三网已真实上报，BD 留空 | 5 | 1 | 3 | 1 | 否 | 保留 | [K-Ping] [C-Agent] [Live] |
| 任意 ICMP/TCP/HTTP PingTask | 成熟：CRUD、排序、间隔、权重、节点范围、历史统计 | 缺失；只有四个固定目标 | 不存在 | 5 | 4 | 4 | 2 | 是 | P1 | [K-Ping] [C-Agent] |
| 新节点默认应用任务 | 成熟 | 无 | 不存在 | 3 | 3 | 2 | 2 | 是 | 随 PingTask P1 | [K-Ping] |
| NextTrace | **协议预留**：类型和测试存在，未发现注册/路由/调度 | 无 | 不存在 | 3 | 5 | 4 | 3 | 是 | P2 独立设计 | [K-NetProto] |
| MeshTrace | **协议预留**：同上 | 无 | 不存在 | 2 | 5 | 5 | 4 | 是 | P2/暂缓 | [K-NetProto] |
| iperf3 | **仅方法名预留**，未见完整参数/结果产品链路 | 无 | 不存在 | 2 | 5 | 5 | 4 | 是 | 不以 Komari 为参考实现 | [K-NetProto] |
| 低频网页可用性/截图检查 | 无对应核心能力 | 无 | 不存在 | 3 | 4 | 4 | 2 | 否 | P2，Browser Run | [CF-Free] |

### 通知与事件

| 能力 | Komari 状态 | 当前 CF 源码 | 当前线上 | 价值 | 复杂 | 额度 | 风险 | Agent 改动 | 优先级 | 证据 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| 节点离线与恢复、每节点开关、grace period | 成熟 | 完整；全局分钟阈值 + 每节点禁用 | 源码已部署，但全局阈值为 0 | 5 | 1 | 2 | 1 | 否 | 保留/启用前验收 | [K-Notify] [C-Notify] [Live] |
| 到期提醒与自动续期 | 成熟 | 完整 | 提醒为 0，未启用；续期逻辑已部署 | 4 | 1 | 1 | 1 | 否 | 保留 | [K-Notify] [C-Notify] [Live] |
| 资源负载告警与恢复 | 成熟，CPU/GPU/RAM/swap/load/temp/disk/上下行等 | 部分：CPU/RAM/disk/上下行，平均或连续窗口 | 规则数 0，未启用 | 5 | 2 | 3 | 1 | 否 | 保留并扩指标 | [K-Notify] [C-Notify] [Live] |
| 流量阈值提醒 | 成熟，起始百分比后每 +5% 提醒 | 只有用量显示，无通知 | 不存在 | 4 | 2 | 2 | 1 | 否 | P1 | [K-Notify] [C-Traffic] |
| 日/周/月流量报告 | 当前成熟，但源码明确写明 1.5.0 将移至插件 | 无 | 不存在 | 4 | 3 | 3 | 1 | 否 | P1，自行设计 | [K-TrafficReport] |
| 登录成功通知 | 成熟，创建 Session 后触发 | 无 | 不存在 | 4 | 2 | 1 | 2 | 否 | P0 | [K-Login] |
| 登录失败审计与聚合告警 | **未发现** | 无 | 不存在 | 5 | 3 | 2 | 3 | 否 | P0，自有增强 | [K-Login] [C-Auth] |
| 通知模板、总开关、测试通知 | 成熟 | 有测试通知；模板与 Provider 配置未结构化 | 凭据未配置 | 4 | 2 | 1 | 2 | 否 | P0 | [K-Settings] [C-Notify] [Live] |
| Provider：Telegram/email/Bark/webhook/Server酱³/Turbo/JS | 成熟；JS 依赖 Komari runtime | 自动识别 Telegram、企微、飞书、钉钉、OneBot、Bark、Server酱、WxPusher、Gotify | 无凭据，未发送 | 4 | 2 | 2 | 3 | 否 | 保留并结构化 | [K-Senders] [C-Notify] [Live] |
| 投递记录、可观察失败与异步重试 | 无完整产品化记录 | 进程内最多 3 次重试，无持久投递状态 | 无通知流量 | 5 | 3 | 2 | 2 | 否 | P0/P1 Queues | [C-Notify] [CF-Free] |

### 认证、安全与审计

| 能力 | Komari 状态 | 当前 CF 源码 | 当前线上 | 价值 | 复杂 | 额度 | 风险 | Agent 改动 | 优先级 | 证据 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| 用户名密码登录 | 成熟，可禁用密码登录 | 单管理员密码 + JWT | 已真实登录 | 5 | 1 | 1 | 3 | 否 | 保留 | [K-Settings] [C-Auth] [Live] |
| GitHub、QQ、generic OIDC | 成熟，支持绑定/解绑 | 无 | 不存在 | 4 | 4 | 2 | 4 | 否 | P1 | [K-OAuth] [K-Router] |
| TOTP 2FA | 成熟 | 无 | 不存在 | 5 | 4 | 1 | 4 | 否 | P1 | [K-Router] [K-Model] |
| 敏感操作二次 2FA | 成熟，用于命令/终端等 | 无单独机制 | 不存在 | 3 | 4 | 1 | 4 | 否 | 随 2FA 评估 | [K-Router] |
| Session 设备管理：首次/最近 IP、UA、方式、在线、过期、撤销 | 成熟 | JWT，无设备 Session 列表 | 不存在 | 5 | 4 | 2 | 4 | 否 | P1 | [K-Session] [C-Auth] |
| 私有站点、API key、CORS/WS Origin | 成熟 | 私有站点、JWT、CORS；DO Origin 策略 | API 与登录已验 | 5 | 1 | 1 | 3 | 否 | 保留 | [K-Settings] [C-CORS] [Live] |
| 私有站点临时分享 `temp_key` | **局部链路**：cookie/查询参数校验存在，未找到生成或管理 API | 无同型能力 | 不存在 | 2 | 3 | 1 | 4 | 否 | 不按成熟能力排期 | [K-TempShare] |
| Turnstile 与 CSP | Komari 无同型 Turnstile；有自身 Origin/会话策略 | 完整 | 代码已部署；当前未配置 widget/secret | 5 | 1 | 1 | 2 | 否 | 保留 | [C-Auth] [C-CSP] [Live] |
| 管理操作审计日志 | 成熟，类型筛选与分页 | 无产品审计表 | 不存在 | 5 | 3 | 3 | 2 | 否 | P0 | [K-Audit] |
| 访客审计、字段边界、每 IP token bucket | 成熟，默认关闭 | 无 | 不存在 | 3 | 4 | 4 | 3 | 否 | P2 | [K-VisitorAudit] |
| 访客 IP 返回控制 | 成熟 | 无独立等价开关 | 不存在 | 3 | 2 | 1 | 2 | 否 | P1 | [K-Settings] |
| Workers Logs / Traces | 非 Cloudflare 架构 | 可由平台提供，仓库未形成完整运维策略 | Worker 在运行；未作为长期审计 | 4 | 2 | 2 | 2 | 否 | P0 | [CF-Free] |

### 主题、扩展、远程控制与恢复

| 能力 | Komari 状态 | 当前 CF 源码 | 当前线上 | 价值 | 复杂 | 额度 | 风险 | Agent 改动 | 优先级 | 证据 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| 主题安装/删除/启用/更新/导入、市场源 | 成熟 | 远程主题商店、commit 版本、预览、Mikus | 远程主题未配置；内置主题已验 | 4 | 2 | 2 | 3 | 否 | 保留现有模型 | [K-Router] [C-Theme] [Live] |
| managed/raw HTML/redirect 主题、多语言 manifest、丰富配置类型 | 成熟 | 部分：反代 `index.html/assets` + `theme_options` | 未配置第三方主题 | 3 | 4 | 2 | 4 | 否 | P2 按需求补 | [K-Theme] [C-Theme] |
| 自定义 head/body/favicon | 成熟 | 主题可控制前端；无完全等价后台模型 | 部分 | 2 | 2 | 1 | 4 | 否 | P2 | [K-Settings] [C-Theme] |
| 服务端插件、市场、配置、日志、公开/管理页 | 成熟 | 无 | 不存在 | 2 | 5 | 5 | 5 | 否 | 不做 | [K-Plugin] |
| JS/Node-like runtime、HTTP/WS hook、进程、监听、文件系统权限 | 成熟但高权限 | Workers 不适配 | 不存在 | 1 | 5 | 5 | 5 | 否 | 不做 | [K-Plugin] |
| Web 终端 | 成熟 | 无 | 不存在 | 2 | 5 | 5 | 5 | 是 | 不做 | [K-Router] |
| 多节点远程命令、队列、结果、退出码 | 成熟 | 无 | 不存在 | 2 | 5 | 5 | 5 | 是 | 不做 | [K-Remote] |
| 剪贴板 | 成熟 | 无 | 不存在 | 1 | 3 | 2 | 4 | 可选 | 不做 | [K-Router] |
| ZIP 备份下载、一致性 SQLite 快照、主题/插件归档 | 成熟 | 只有节点导入导出，不是全站备份 | 无全站备份 | 5 | 4 | 4 | 3 | 否 | P1，改用 D1/R2 | [K-Backup] [C-Admin] |
| 分片上传恢复、校验、防 ZIP bomb、pre-restore 快照 | 成熟 | 无 | 不存在 | 5 | 5 | 4 | 5 | 否 | 不照搬；做 Cloudflare 原生恢复 | [K-Restore] [CF-Free] |
| 数据库大小、空间回收与指标库迁移 | 成熟 API；按 SQLite/MySQL/PostgreSQL 使用不同维护动作 | 只有 D1 用量查询；维护由平台负责 | 用量接口已部署 | 3 | 3 | 2 | 3 | 否 | 不移植维护引擎 | [K-DBMaint] [K-Metric] [C-Usage] |
| 管理员表枚举、任意 SQL query/exec | 成熟 API；exec 会写审计，但权限面极高 | 无 | 不存在 | 1 | 4 | 3 | 5 | 否 | 不做 | [K-DBRPC] |
| 管理员 pprof、CPU profile 与 runtime trace | 成熟 API；只适用于长驻 Go 进程 | 无同型；由 Workers Logs/Traces/平台指标替代 | 平台能力可用，未形成运维手册 | 3 | 2 | 2 | 3 | 否 | P0 采用 CF 原生观测 | [K-Pprof] [CF-Free] |
| GitHub Pages 多 API 聚合 | 非核心 | 完整，是 CFSM 优势 | 源码存在，未对本测试站单独验 | 3 | 1 | 1 | 2 | 否 | 保留 | [C-README] |
| iOS Scriptable 小组件 | 非核心 | 完整，是 CFSM 优势 | 源码存在，未实机验 | 3 | 1 | 1 | 2 | 否 | 保留 | [C-README] |
| D1/Workers/DO 用量查询 | 非 Cloudflare 架构 | 完整，但额度显示需按 2026 官方值复核 | 接口已部署 | 5 | 2 | 1 | 2 | 否 | P0 校正 | [C-Usage] [CF-Free] |
| Agent 动态配置、WSS/POST 切换、服务端时间校准 | 非同型 | 完整 | HTTP 在线；WSS 已验后关闭 | 5 | 1 | 2 | 2 | 否 | 保留 | [C-Agent] [C-DO] [Live] |
| 前端订阅感知节流、无告警时降低 DO 消耗 | 非同型 | 完整，是 CF 原生优势 | 已部署 | 5 | 2 | 1 | 1 | 否 | 保留 | [C-DO] [C-Agent] [Live] |

## 三个必须纠正的旧结论

1. **Komari 不是“登录成功/失败通知都有”**。当前通知位于 `CreateSession` 成功路径；全仓库未发现登录失败通知链路。因此 CF 版若同时实现成功和失败事件，失败事件是自己的安全增强。
2. **Komari 内建周期流量报告不是稳定的长期核心**。源码发送内容明确提示将在 1.5.0 移除并迁往插件。CF 版可以做周期报告，但应独立设计数据口径、幂等和通知流程。
3. **NextTrace、iperf3、MeshTrace 不是成熟产品能力**。除 `protocol/v2/networktest.go` 和测试外没有方法注册、路由、调度或管理 API；其中 iperf3 只看到方法名。路线图不得把这些协议预留写成可直接移植的上游实现。

## 高价值路线图

### P0：先补控制面，不改 Agent

| 工作包 | 最小范围 | 验收边界 |
| --- | --- | --- |
| 安全事件 | 登录成功/失败审计；失败按 IP/时间窗聚合；可选通知 | 不记录密码、JWT、Secret；有 retention 和限流 |
| 管理审计 | 节点/设置/通知/主题等高价值写操作 | 不记录每次读请求和每个指标包；可分页、可清理 |
| 节点语义 | `internal_note` 与 `public_note`；补 `min` 流量算法 | 迁移兼容旧 `note`；四种旧算法结果不变 |
| 通知可靠性 | Provider 类型显式化、投递结果、错误可见 | 现有九类渠道兼容；敏感字段不回显 |
| 免费额度与运维 | 更新用量面板；D1 Time Travel、Logs、Traces 文档 | 数值来自 [Cloudflare 免费层核验](cloudflare-free-platform-2026.md) |

#### P0 实施状态（2026-08-18，本地工作树）

| 工作包 | 实施结果 | 明确保留到后续阶段 |
| --- | --- | --- |
| 安全事件 | 已完成成功/失败事件、IP + 五分钟窗口聚合、20 次写上限、90 天保留和 best-effort 故障隔离 | 登录事件通知仍为可选增强 |
| 管理审计 | 已覆盖设置、主题设置、通知测试、节点增删改、排序、批量删除和导入；API 支持精确筛选与分页 | 独立 Audit Tab 为后续界面增强 |
| 节点语义 | 已完成内部/公开备注迁移与公开字段边界，已增加 `min` 并锁定旧算法结果 | 无 Agent 协议改动 |
| 通知可靠性 | 已完成显式 Provider、九类旧格式兼容、最多三次同步重试、结构化结果、30 天投递记录和凭据不回显；Provider 切换需新凭据 | Queues、死信与异步退避仍为 P1 |
| 免费额度与运维 | 已统一面板常量并按官方页面复核；已增加 Time Travel、Logs、Traces 和脱敏手册 | R2 归档和 Workflows 不进入 P0 |

本地验收为 41 项测试、生产构建和 Wrangler dry-run 全部通过；未提交、未部署、未推送，也未改变 `2024-12-01` compatibility date。下方能力矩阵仍保留为固定提交 `1662281` 与当时线上快照的研究基线，不应用本节结果反向改写历史证据。

### P1：新增数据表、权限或异步绑定

| 工作包 | 依赖 | 核心取舍 |
| --- | --- | --- |
| Session 管理 | Session 表、refresh/revoke 语义 | 先做单管理员设备会话，不急于多用户/RBAC |
| TOTP 2FA | 加密保存 secret、recovery 流程 | 先保护登录和关键设置，不引入远程命令 |
| GitHub OAuth / generic OIDC | OAuth state、回调域名、账户绑定 | 选一个 Provider 先落地；保留密码应急登录 |
| 任意 PingTask | Agent 协议、任务表、结果表、调度 | 第一版只做 ICMP/TCP/HTTP；不夹带 traceroute/iperf |
| 通知 Queue | Queues binding、死信/重试策略 | 只承接控制面事件，避免 10k operations/day 被指标耗尽 |
| D1 → R2 备份 | R2 binding、manifest、恢复校验 | Time Travel 负责短期回滚，R2 负责可下载/跨环境导出 |
| 周期流量报告 | 查询口径、幂等键、通知 Queue | 独立实现，不复制 Komari 即将废弃的内建模块 |

### P2：实验或额度敏感

- Analytics Engine：CFSM 自身用量、告警统计、高基数遥测。
- Browser Run：每天数次的网页可用性、内容检查或截图。
- Workflows：备份/报告/诊断的多步骤编排。
- R2 Data Catalog + R2 SQL：只有形成大规模 Parquet/Iceberg 冷历史后再实验，不作为 D1 或普通 R2 备份的替代。
- Secrets Store：Provider 密钥和 Worker 数量增加后再迁移。
- GPU 温度与逐卡显存：先扩 Agent，再扩历史和图表。
- traceroute/mesh：只有真实用户需求后独立设计，不能复用一个“协议预留”作为成熟方案。

## 当前线上快照

2026-08-18 12:51 CST 的只读查询结果：

- Worker：`cf-server-monitor-komari`；绑定 D1、Static Assets、`MetricsBroadcaster` Durable Object 和一个 Secret binding。Secret 值未读取。
- D1：`cf-server-monitor-komari-db`，当前大小 57,344 bytes；表为 `_cf_KV`、`settings`、`servers`、`metrics_history`。
- 节点：`jp-cfsm-test`；Agent `v1.0.8`；`metrics_history` 66 条，最新记录为 12:50:39，查询时不到一分钟，可判定持续在线。
- 已启用/验证：HTTP 上报、实时与历史读取、三网延迟/丢包、管理员登录、桌面/移动前端。
- 已部署但关闭：`wss_report_enabled=false`；WSS 曾真实验证后恢复 HTTP，以避免持续 DO duration。
- 未配置：离线通知阈值、到期提醒、资源告警规则、通知凭据、远程主题、Turnstile widget/secret。
- 优化开关：`history_id_optimized=true`、`servers_optimized=true`；长历史点数为 120。

这组快照只说明当前测试实例的启用状态，不改变“源码能力”判断。线上资源与安全边界详见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 证据索引

### Komari 固定提交

[K-Router]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/router/router.go
[K-Settings]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/internal/config/settings.go
[K-Model]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/database/models/models.go
[K-GPU]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/protocol/v1/report.go
[K-Metric]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/rpc/jsonrpc/admin.metric.go
[K-Rollup]: https://github.com/komari-monitor/komari/tree/da4d5187c1b10da3c5893595c5e2a9fd54d13792/pkg/metric
[K-Ping]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/rpc/jsonrpc/admin.ping.go
[K-NetProto]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/protocol/v2/networktest.go
[K-Notify]: https://github.com/komari-monitor/komari/tree/da4d5187c1b10da3c5893595c5e2a9fd54d13792/utils/notifier
[K-TrafficReport]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/utils/notifier/traffic_report.go#L133
[K-Login]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/database/accounts/sessions.go#L28-L64
[K-Senders]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/utils/messageSender/all.go
[K-OAuth]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/oauth/all.go
[K-Session]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/database/models/models.go#L60-L72
[K-Audit]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/rpc/jsonrpc/admin.system.go#L30-L98
[K-VisitorAudit]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/rpc/jsonrpc/public.audit.go
[K-Theme]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/database/models/theme.go
[K-Plugin]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/database/models/plugin.go
[K-Remote]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/rpc/jsonrpc/admin.system.go#L100-L165
[K-Backup]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/api/admin/download.go
[K-Restore]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/backup/restore.go
[K-DBCore]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/database/dbcore/dbcore.go#L235-L390
[K-DBMaint]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/rpc/jsonrpc/admin.database.go
[K-DBRPC]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/rpc/jsonrpc/admin.dbquery.go
[K-Pprof]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/api/admin/pprof.go
[K-TempShare]: https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/web/rpc/jsonrpc/transport.go#L189-L204

### 当前 Fork 固定提交

[C-README]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/README.md
[C-Schema]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/src/database/schema.js
[C-Sampling]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/src/database/historySampling.js
[C-Agent]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/agent-go.md
[C-Admin]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/src/handlers/admin.js
[C-Notify]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/src/services/notification.js
[C-Traffic]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/src/frontend/composables/useServerCardData.js
[C-Auth]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/src/middleware/auth.js
[C-CORS]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/src/utils/cors.js
[C-CSP]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/src/utils/csp.js
[C-Theme]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/src/handlers/theme.js
[C-Usage]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/API.md#35-action-d1_usage---d1--workers--durable-objects-用量
[C-DO]: https://github.com/benbenwu1/CF-Server-Monitor-Komari/blob/1662281220a9c96fe37c9906b28911d3c0fe1d63/src/durable/MetricsBroadcaster.js
[Live]: DEPLOYMENT.md
[CF-Free]: cloudflare-free-platform-2026.md
