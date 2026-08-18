# CF-Server-Monitor 与 Komari 上游对比

## 调研快照

| 项目 | 固定提交 | 提交时间 | 许可 |
| --- | --- | --- | --- |
| CF-Server-Monitor | [`a4911ff`](https://github.com/huilang-me/CF-Server-Monitor/tree/a4911ffa8664e047ea672d735a32d8ffde1c01da) | 2026-08-15 | `package.json` 声明 MIT，但该快照根目录没有 `LICENSE` 文件 |
| cfsm-agent | [`b435168`](https://github.com/huilang-me/cfsm-agent/tree/b435168ab8585aed10801d3e2918ba2fa09342b4) / `v1.0.8` | 2026-08-17 | [MIT](https://github.com/huilang-me/cfsm-agent/blob/b435168ab8585aed10801d3e2918ba2fa09342b4/LICENSE) |
| Komari | [`da4d518`](https://github.com/komari-monitor/komari/tree/da4d5187c1b10da3c5893595c5e2a9fd54d13792) | 2026-08-17 | [MIT](https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/LICENSE) |

两个项目都在快速更新，因此本文对结论绑定到上述提交，不把浮动的 `main` 当成可重现依据。

## 定位和架构

| 维度 | CF-Server-Monitor | Komari | 新项目决策 |
| --- | --- | --- | --- |
| 部署形态 | Workers + D1 + Durable Objects + Static Assets，原生适配 Cloudflare | 长驻 Go 进程 + 本地/外部数据库 + 文件系统 | 完整保留 CFSM 架构 |
| 前端 | Vue 3 + Vite + Chart.js + Leaflet | 独立 Web/主题生态，Go 服务端提供 API | 继续用 CFSM Vue 前端，只借鉴交互 |
| Agent | `cfsm-agent` 单向 HTTPS/WSS 上报 | Komari Agent 与服务端双向交互 | 第一阶段只用 `cfsm-agent` |
| 实时通道 | Durable Objects；前端连接用 Hibernation API，Agent 高频上报用标准 WS | Go 进程长连接 | 保留 CFSM 的额度优化模型 |
| 数据持久化 | D1 月/周期表、长历史抽样与读行优化 | 通用 metric store、raw/rollup/压缩 | 不移植 Komari metric store，持续优化 D1 |

CFSM 的架构与数据流见其 [README 系统架构](https://github.com/huilang-me/CF-Server-Monitor/blob/a4911ffa8664e047ea672d735a32d8ffde1c01da/README.md#%E7%B3%BB%E7%BB%9F%E6%9E%B6%E6%9E%84)。Agent WSS/POST 协议和运行节流见 [agent-go.md](https://github.com/huilang-me/CF-Server-Monitor/blob/a4911ffa8664e047ea672d735a32d8ffde1c01da/agent-go.md#%E4%B8%8A%E6%8A%A5%E6%95%B0%E6%8D%AE%E8%AF%B4%E6%98%8E)。Komari 官方定位见其 [README](https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/README_zh-cn.md)。

## 功能矩阵

| 能力 | CF-Server-Monitor | Komari | 判断 |
| --- | --- | --- | --- |
| CPU/内存/swap/磁盘/网络/负载/uptime | 有 | 有 | 直接复用 CFSM |
| GPU、磁盘 IO、进程/连接数 | 有 | 有 | 直接复用 CFSM |
| 实时前台 | DO + WS，按有无前端订阅调整 Agent 频率 | 官方定位为秒级数据 | CFSM 更符合 CF 计费模型 |
| 历史图表 | 7 天、长时段采样、播放 | raw + rollup + 压缩 | 保留 D1 版，不搬 Komari 存储引擎 |
| 延迟/丢包 | Agent 直接上报电信/联通/移动，并支持可选 `BD` 第四自定义节点 | 可管理 PingTask，可按节点适用 | CFSM 当前够用；任意 PingTask 列入后续 |
| 月流量/校正/重置 | 有 | 有 | 复用 CFSM |
| 节点 CRUD/排序/隐藏/分组 | 有 | 有 | 复用 CFSM |
| 价格/计费/到期日 | 有 | 有 | 复用 CFSM |
| 地图、条形/环形/表格视图 | 有 | 主题决定 | CFSM 保留，这是优势 |
| GitHub Pages 多 API 聚合 | 有 | 非核心 | CFSM 保留 |
| iOS Scriptable 小组件 | 有 | 非核心 | CFSM 保留 |
| 离线/恢复通知 | 有 | 有 | 复用 CFSM |
| 资源负载告警 | 有 | 有 | 复用 CFSM |
| 到期提醒 | 有 | 有 | 复用 CFSM |
| 周期流量报告 | 无明确同等功能 | 有 `TrafficReportNotification` | 适合第二阶段实现 |
| 登录通知 | 无明确同等功能 | 有 | 适合第二阶段实现 |
| 单管理员 JWT | 有 | 有 session/account | CFSM 第一阶段足够 |
| Turnstile/CORS/CSP | 有 | 有自身 Origin/会话策略 | 复用 CFSM |
| OAuth/2FA | 无明确同等功能 | 有 | 需要时独立设计，不直接拷贝 |
| 审计日志 | 无明确同等功能 | 有 | 适合第二阶段，需限制 D1 写入 |
| 主题商店/预览 | 有远程主题反代和预览 | 有 managed/raw/redirect 主题 | 优先完善 CFSM 现有实现 |
| 服务端插件 | 无 | 有嵌入 JS 运行时、route/hook/WS 拦截 | 不适合 Workers，不移植 |
| Web 终端/远程命令 | 明确不提供 | 有 | 继续不做，保持 Agent 单向上报 |
| 剪贴板 | 无 | 有 | 不是监控核心，不做 |

CFSM 的完整特性表见 [README 特性](https://github.com/huilang-me/CF-Server-Monitor/blob/a4911ffa8664e047ea672d735a32d8ffde1c01da/README.md#%E7%89%B9%E6%80%A7)。Komari 的 OAuth、2FA、通知和主题开关可从 [settings.go](https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/internal/config/settings.go) 核对；流量报告模型见 [notification.go](https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/database/models/notification.go)；插件权限面见 [plugin.go](https://github.com/komari-monitor/komari/blob/da4d5187c1b10da3c5893595c5e2a9fd54d13792/database/models/plugin.go)。

## Cloudflare 约束下的取舍

1. **请求数与 D1 写入**：实时展示不能等于每个实时包都写 D1。CFSM 已将实时广播和历史持久化解耦，应保留。
2. **Durable Objects duration**：Agent 长连接会产生持续时长；上游通过无前端订阅时降低上报频率减少开销，不应为追求 Komari 的固定 1 秒刷新而删除。
3. **文件系统与长驻进程**：Komari 插件安装、嵌入 JS 运行时、本地文件和进程管理不能直接对应 Workers 运行模型。
4. **双向控制面**：远程终端和命令会破坏 CFSM 的单向上报安全边界，也会显著增加 Agent 和 DO 的复杂度。

## 实施顺序

### Phase 0：干净 Fork 与独立部署

- 保留上游完整历史与 `upstream` 远程。
- 修复已知高危依赖告警。
- 使用全新 Worker、D1、DO 和 Secret 部署。
- 用独立测试节点跑通 `cfsm-agent`。

### Phase 1：可验收的监控产品

- 完成项目命名、版本标识和部署文档，保留上游署名。
- 验证实时、历史、三网与可选 `BD` 延迟/丢包、告警、地图和节点管理。
- 增加稳定的部署前/部署后健康检查。

### Phase 2：借鉴 Komari 的高价值能力

1. 登录成功/失败通知与管理操作审计日志。
2. 按日/周/月的流量报告。
3. 更完整的访客展示权限。
4. 需求明确后再评估 TOTP 2FA 或 GitHub OAuth。

### 不进入路线图

- Komari Agent 协议兼容。
- Web 终端、远程命令、剪贴板。
- Komari 服务端插件运行时。
