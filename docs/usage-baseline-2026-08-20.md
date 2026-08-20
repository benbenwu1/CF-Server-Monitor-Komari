# Cloudflare 用量基线（2026-08-20）

> 采集时间：2026-08-20 02:42 UTC / 10:42 Asia/Shanghai。本文只记录聚合用量、公开资源标识和安全结论，不包含 Secret、JWT、Agent Secret、完整请求 Header 或客户端 IP。

## 结论

独立测试环境当前远低于 Workers Free、D1 Free 和 Durable Objects Free 的日额度。2026-08-19 完整 UTC 日中，本项目 Worker 请求占 2.933%，D1 写入占 1.500%，D1 读取占 0.294%，Durable Objects 估算请求占 1.607%，DO duration 占 0.041%。结合 2026-08-18 上线后的部分日和 2026-08-20 当前部分日，约 47 小时内主 Worker 始终为 0 error，未出现 CPU、内存或 DO fatal resource error，现有单节点开发阶段基线已经建立。

通知 Queue、周期流量快照和隔离 D1 全量备份 Workflow 尚未部署，本基线只反映当前线上版本 `6225658f-c926-47e0-abc0-7e06219e63e5`。

## 采集范围

| 项目 | 精确范围 |
| --- | --- |
| Cloudflare account | `f98b997d2fb3844848fdbd181040b4da` |
| Worker | `cf-server-monitor-komari` |
| Worker Version | `6225658f-c926-47e0-abc0-7e06219e63e5`，100% 流量 |
| D1 | `cf-server-monitor-komari-db` / `fc52eab7-4134-4a12-bb2f-8777df48f89a` |
| Durable Object namespace | `MetricsBroadcaster` / `221dc9f038ae40a899990f36685d41ca` |
| 测试节点 | 1 台，`cfsm-agent v1.0.8`，HTTP POST 上报 |

数据来自 Wrangler 4.120.0、D1 远程只读查询和 Cloudflare GraphQL Analytics API。GraphQL adaptive 数据可能存在采样与摄取延迟，因此适合容量趋势和异常状态判断，不作为逐请求审计日志。

## 免费额度依据

当前 Cloudflare 官方口径：

- [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)：Free 为 100,000 requests/day，HTTP 请求 CPU 上限为 10 ms；运行时允许少量偶发超限滚动，但持续超限会终止执行。
- [Workers Pricing - D1](https://developers.cloudflare.com/workers/platform/pricing/#d1)：Free 为 5,000,000 rows read/day、100,000 rows written/day、5 GB 总存储。
- [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)：Free 为 100,000 requests/day、13,000 GB-s/day；SQLite 行读写与存储额度同 D1。

所有日额度在 00:00 UTC 重置。

## 2026-08-19 完整 UTC 日

| 指标 | 实际值 | Free 日额度 | 占比 |
| --- | ---: | ---: | ---: |
| Worker requests | 2,933 | 100,000 | 2.933% |
| Worker errors | 0 | — | 0% |
| Worker CPU 总量 | 8.472 秒 | 非日总量计费项 | 平均约 2.889 ms/request |
| D1 rows read | 14,693 | 5,000,000 | 0.294% |
| D1 rows written | 1,500 | 100,000 | 1.500% |
| DO 估算 billable requests | 1,607 | 100,000 | 1.607% |
| DO duration | 5.388 GB-s | 13,000 GB-s | 0.041% |
| DO outbound WebSocket messages | 1,540 | 不计费 | — |

DO 的 1,607 次估算请求由 1,607 次 HTTP/hibernation invocation 和 0 条 incoming WebSocket message 构成；outbound WebSocket message 不计入请求计费。Agent WSS 已关闭，但访客前端实时订阅仍通过 `MetricsBroadcaster` 使用 WebSocket/DO，这是 DO 持续有用量的主要原因。

## 上线以来全部可用日期

Worker 于 2026-08-18 03:32 UTC 创建，因此当前物理上只有一个完整 UTC 日。为避免把未来数据伪装成历史观测，本次同时核验上线后的两个部分日，并把 7 日观察保留为实际扩容动作的运维前置条件，而不是当前开发阶段的阻塞项。

| UTC 日期 | 覆盖范围 | Worker requests / errors | D1 read / write | DO 估算请求 | DO duration | Resource errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 2026-08-18 | 03:32–23:59，部分日 | 2,640 / 0 | 7,737 / 1,225 | 1,414 | 20.798 GB-s | 0 |
| 2026-08-19 | 00:00–23:59，完整日 | 2,933 / 0 | 14,693 / 1,500 | 1,607 | 5.388 GB-s | 0 |
| 2026-08-20 | 00:00–03:01，部分日 | 412 / 0 | 6,767 / 180 | 254 | 0.476 GB-s | 0 |

2026-08-18 的 DO duration 较高，包含首次部署和 Agent WSS/前端链路验证；验证后已恢复 Agent HTTP POST。2026-08-20 的 D1 rows read 包含本次基线审计自身的聚合查询，不能用于线性外推。三段数据均没有 Worker error、`exceededCpuErrors`、`exceededMemoryErrors` 或 `fatalInternalErrors`。

## 滚动 24 小时性能快照

| 指标 | 值 |
| --- | ---: |
| Worker requests | 2,956 |
| Worker subrequests | 1,408 |
| Worker errors | 0 |
| CPU P50 / P95 / P99 | 2.104 / 6.409 / 11.466 ms |
| CPU max | 28.999 ms |
| CPU 平均值 | 2.851 ms/request |
| 内存 P50 / P95 / P99 | 2.96 / 3.46 / 3.71 MiB |
| 内存 max | 4.50 MiB |
| D1 rows read / written | 14,614 / 1,465 |
| D1 当前大小 | 约 1.04 MiB |
| DO raw invocations | 1,614 |
| DO duration | 5.441 GB-s |
| DO SQLite stored bytes | 16 KiB |

CPU P99 和 max 高于 Free 的 10 ms 标称上限，但主 Worker 没有 `exceededResources` 或其他 invocation error。Cloudflare 官方说明运行时允许少量偶发 CPU rollover；当前平均值和 P95 均明显低于 10 ms，因此先观察趋势，不按单个高分位值判定容量故障。

## D1 数据规模

| 表 | 行数 |
| --- | ---: |
| `servers` | 1 |
| `metrics_history` | 2,790 |
| `admin_sessions` | 2 |
| `audit_events` | 6 |
| `notification_deliveries` | 0 |
| `ping_tasks` / assignments / results | 0 / 0 / 0 |
| GitHub OAuth identities/states/exchange codes | 0 / 0 / 0 |

`metrics_history` 当前覆盖 `2026-08-18T03:43:57.329Z` 至 `2026-08-20T02:32:20.508Z`，只有 1 个 server ID。当天部分 D1 rows read 被本次基线审计自身的聚合查询放大，因此趋势比较优先使用 2026-08-19 完整 UTC 日和后续自动/固定口径快照。

## 健康与异常观察

通过 macOS 当前系统 HTTP 代理探测：

- `/` 返回 200，探测耗时约 0.91 秒。
- `/__do/health` 返回 200，探测耗时约 0.59 秒。
- `/api/servers` 返回 1 台服务器。
- 实时 tail 中 Agent `/update` 返回 204，Cron、DO `/batch-push` 和 DO health 均成功。

滚动 24 小时主 Worker errors 为 0。DO 聚合状态中包含 48 次 `clientDisconnected`、11 次 `responseStreamDisconnected`、6 次 `scriptThrewException` 和 2 次 `internalError`。实时样本确认连接断开主要来自前端 WebSocket 生命周期，且未影响 Agent HTTP 上报、Cron、健康接口或页面请求。

针对 hibernation 脚本异常，已尝试实时 error tail 和正常前端 WebSocket 连接/订阅/关闭路径，但没有获得包含异常堆栈的可复现红灯信号，也没有用户可见故障。按照调试门禁，当前不根据聚合状态猜测根因或做无证据改码；扩容前继续记录每日数量，若出现增长、用户可见断连或 `exceededResources`，再通过临时受控日志或可复现输入进入独立诊断。

## 容量判断

以 2026-08-19 单节点完整日为基准、只做线性估算：

- Worker requests 到 Free 日额度约有 34 倍余量。
- D1 rows written 到 Free 日额度约有 66 倍余量。
- D1 rows read 到 Free 日额度超过 300 倍余量。
- DO requests 到 Free 日额度约有 62 倍余量。
- DO duration 到 Free 日额度超过 2,400 倍余量。

这些倍数不是可直接部署的节点上限。前端访问、审计查询、通知 Queue、数据保留策略和 PingTask 会改变增长曲线。尤其 10 个 60 秒 PingTask 每节点理论上可新增约 14,400 条结果/日，必须单独按 D1 写入预算核算。

## 扩容前运维门禁

以下条件不阻塞当前 P1 开发阶段完成，但任何实际扩容节点或启用高频 PingTask 的操作都必须先连续记录 7 个完整 UTC 日，并满足：

1. Worker、D1 rows read/write、DO requests 和 DO duration 的单日峰值均低于对应 Free 额度的 50%。
2. Worker 不出现 `exceededResources`、持续 `scriptThrewException` 或用户可见 5xx。
3. DO hibernation 脚本异常不呈增长趋势；连接断开状态需与真实前端连接生命周期相符。
4. `metrics_history` 增长与节点数、上报频率一致，没有异常写放大。
5. Queue 部署后另行加入 Queue operations/day；隔离备份 Workflow 部署后另行加入 steps/day、storage 和执行状态。

当前开发阶段的用量基线和容量判断已经完成。7 日观察属于未来扩容操作的前置条件，不应在数据尚未产生时伪造完成，也不应继续作为当前代码阶段的未完成开发项。
