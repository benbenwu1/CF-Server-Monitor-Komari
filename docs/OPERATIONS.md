# Cloudflare 运维手册

> 最后核验：2026-08-20。本文只使用公开资源名和占位符，不应粘贴 API Token、`API_SECRET`、JWT、通知凭据或数据库中的 Secret。

## 能力边界

- D1 Time Travel 在 Workers Free 上保留 7 天，用于同一数据库的短期原地回滚。它不是可下载、可跨账户的备份。
- Workers Logs 是短期故障定位工具；Free 为 200,000 observability events/天，保留 3 天。
- Workers Traces 用于分析 Worker、Durable Object 和 D1 链路。2026-10-01 起，每个 span 作为一个 observability event，与 Logs 共用上述额度。
- Workers Free 的 Queues 为 10,000 operations/天，消息保留固定 24 小时；当前只承接低频自动告警，不承接指标流。
- Logs/Traces 可能被采样且会自动过期，不得代替 `audit_events` 中的产品安全审计。

官方原文：

- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers Traces](https://developers.cloudflare.com/workers/observability/traces/)
- [Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Queues Limits](https://developers.cloudflare.com/queues/platform/limits/)

## D1 Time Travel 恢复流程

### 1. 先确定事故时间

全部时间使用 UTC RFC3339，并选择错误操作发生前的时间点。先只查询 bookmark，不执行恢复：

```bash
export D1_NAME='your-d1-database-name'
npx wrangler whoami
npx wrangler d1 time-travel info "$D1_NAME" --json
npx wrangler d1 time-travel info "$D1_NAME" \
  --timestamp '2026-08-18T03:20:00Z' \
  --json
```

保存两个值：

1. 当前状态的 bookmark，用于恢复错误时回到操作前。
2. 目标时间的 bookmark，用于本次恢复。

bookmark 是稳定的数据库时间点标识。正式恢复优先使用 bookmark，避免时区或时间格式误解。

### 2. 进入维护窗口

恢复会丢弃目标 bookmark 之后的数据。执行前：

- 暂停所有 Agent 上报或临时阻断 `/update` 写入，不要在持续写入时估算恢复边界。
- 保留 Worker 和 D1 资源，不删除数据库，不新建同名数据库。
- 记录受影响的节点、设置和大致时间范围。

### 3. 恢复前留下可下载副本

```bash
mkdir -p .local-backups
npx wrangler d1 export "$D1_NAME" --remote \
  --output ".local-backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

`.local-backups/` 不应进入 Git。导出文件可能含管理员设置和通知凭据，只能保存在本机受控位置。

### 4. 按 bookmark 原地恢复

```bash
npx wrangler d1 time-travel restore "$D1_NAME" \
  --bookmark 'TARGET_BOOKMARK' \
  --json
```

不要把 `restore` 放入无人值守的自动化任务。命令结束后先保留输出，再恢复 Agent 写入。

### 5. 验证再恢复流量

```bash
npx wrangler d1 execute "$D1_NAME" --remote \
  --command "SELECT COUNT(*) AS servers FROM servers;"
npx wrangler d1 execute "$D1_NAME" --remote \
  --command "SELECT COUNT(*) AS history_rows, MAX(timestamp) AS latest_timestamp FROM metrics_history;"
npx wrangler d1 execute "$D1_NAME" --remote \
  --command "SELECT COUNT(*) AS audit_rows, MAX(last_occurred_at) AS latest_audit FROM audit_events;"
```

然后按顺序验证：

1. `/api/config` 可读。
2. 管理员可登录，节点列表和设置符合目标时间点。
3. 开放一个测试 Agent 上报，确认 `metrics_history` 再次增长。
4. 最后恢复其他 Agent。

如果恢复点选错，立即重新暂停写入，并使用第 1 步保存的“当前状态 bookmark”再执行一次 `restore`。Time Travel 恢复本身不会删除更旧的 bookmark。

## 配置逻辑备份

管理页“数据库管理 → 配置逻辑备份”提供两种手动操作：

1. 下载 `cfsm-logical-backup` JSON 到当前设备。
2. 仅在存在 `BACKUP_BUCKET` binding 时，把同一 JSON 写入私有 R2。

它只保存站点非凭据设置、外观、服务器和 PingTask 配置，不保存指标历史、PingTask 结果、Session、审计、TOTP/OAuth 状态或产品已知凭据。它也不是恢复包；不要把文件 POST 回 `/admin/api`，当前没有导入动作。

### 校验本地文件

文件内的 SHA-256 针对 UTF-8 `JSON.stringify(backup.data)`。以下命令只打印计算值、manifest 值和是否一致，不打印备份正文：

```bash
export BACKUP_FILE='.local-backups/cfsm-config-example.json'
node -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const backup = JSON.parse(fs.readFileSync(process.env.BACKUP_FILE, "utf8"));
const actual = crypto.createHash("sha256").update(JSON.stringify(backup.data)).digest("hex");
const expected = backup.manifest.checksum.value;
console.log({ actual, expected, match: actual === expected });
'
```

校验前把文件放入已被 Git 忽略的 `.local-backups/`，不要使用仓库内其他目录。

### 从私有 R2 下载

管理页成功提示和 `admin.backup.r2_create` 审计会记录对象 key，不记录内容。把 key 作为完整对象路径下载：

```bash
export R2_BUCKET='your-cfsm-private-backups'
export R2_KEY='cfsm-logical-backups/YYYY/MM/DD/cfsm-config-EXAMPLE.json'
mkdir -p .local-backups
npx wrangler r2 object get "$R2_BUCKET/$R2_KEY" \
  --file ".local-backups/$(basename "$R2_KEY")"
```

下载后执行上面的 SHA-256 校验。R2 生命周期是 bucket 级配置，不由 Worker 代码自动修改；配置与检查命令见 [`DEPLOYMENT.md`](DEPLOYMENT.md)。

### 隔离的完整 D1 Workflow 归档

配置逻辑备份不替代第 3 步的 `wrangler d1 export`。完整 SQL 归档已在 [`ops/d1-backup-workflow`](../ops/d1-backup-workflow/README.md) 实现为独立 Worker/Workflow：D1 REST Token 只属于该组件，SQL 只流式写入专用私有 R2，默认 HTTP handler 始终返回 404，且不提供自动恢复。

当前仅本地代码、13 项测试和 Wrangler dry-run 完成；没有创建 R2、API Token、Secret 或 Workflow，也没有改变线上面板 Worker。取得上线授权后仍必须逐项完成：

1. 为目标账户创建仅含 D1 导出读权限的独立 Token，交互式写入该 Worker 的 `D1_REST_API_TOKEN` Secret。
2. 创建不带 `r2.dev`/公共域名的专用 bucket，并对 `cfsm-d1-full-backups/` 配置有界生命周期。
3. 把 schedule 放在真实低峰。D1 export 运行期间数据库可能暂时无法查询。
4. 用 `wrangler workflows instances describe ... latest` 检查分步状态，不打印 step output 中的 signed URL。
5. 下载 `.sql` 与 `.manifest.json` 后，在 manifest MD5 非空时先比对 R2 MD5，再生成并保存本地 SHA-256 sidecar。
6. 只在维护窗口恢复，优先导入全新 D1 并验收后切换 binding；绝不由 Workflow、Cron 或 Actions 自动导入生产库。

对象 key 使用 `cfsm-d1-full-backups/YYYY/MM/DD/<instance-id>.sql` 及同名 manifest。manifest 不含 Token、database ID 或 signed URL。完整资源创建、生命周期、状态、下载和恢复命令见子项目 README。

## 通知 Queue 运维

当前独立测试环境已启用专用 Queue `cf-server-monitor-komari-notifications`（ID `9384c3c58017473e99e49551a0f592d9`），Worker `cf-server-monitor-komari` 同时是唯一 producer 和 consumer。GitHub Actions 使用普通变量 `NOTIFICATION_QUEUE_NAME` 声明同一资源。未配置 `NOTIFICATION_QUEUE` 时，自动告警和已启用的周期流量快照会继续走同步兼容路径。

Queue 只传 job ID，通知正文保存在 `notification_jobs` 最多 30 天；该正文可能包含服务器名称、告警数值、流量快照和时间，仍属于私密运行数据。不要在排查时执行 `SELECT message` 后把结果贴进日志或工单。

Wrangler 4.120.0 与 4.125.0 均没有 `queues message send` 子命令。需要做无害链路探测时，使用 Cloudflare 官方 Queue Push Message API，且消息只能包含不存在的 opaque job ID；不得写入通知正文、Token、Chat ID 或 Provider 配置。发送后必须确认 Worker invocation 成功，并复查 `notification_jobs`、`traffic_report_runs` 没有新增记录。

### Komari 只读告警源

`KOMARI_MONITOR_URL` 当前指向 `https://vps.i404.dev`。Worker 只调用公开 JSON-RPC 方法 `public:getNodesInformation` 和 `common:getNodesLatestStatus`，不得携带生产 Komari Cookie、管理员凭据或节点 Token。阈值固定为：离线 3 分钟、线路平均延迟 200ms、丢包 10%、线路异常持续 5 分钟、流量使用 80% 后每增加 5%、有效期最后 7 天。每日摘要在 00:00 UTC 的前 10 分钟内幂等发送。

运行状态使用 D1 `settings` 中的 `komari_monitor_state_v1`。它只保存节点 UUID 对应的告警状态、首次异常时间、流量告警步进和日报周期键，不保存 Komari 响应全文或任何凭据。飞书凭据缺失时监控直接返回，不请求旧面板，也不写状态。

飞书自建应用模式选择 Provider `feishu_app`。普通变量为 `FEISHU_APP_ID` 和 `FEISHU_RECEIVE_ID_TYPE=union_id`；敏感值必须使用 Worker Secret：`FEISHU_APP_SECRET` 与 `FEISHU_RECEIVE_ID`。发送器先换取 tenant access token，再调用消息 API 向接收人发送交互卡片；token 只在 Worker 内存中短期缓存，不写入 D1、日志或 Queue。Queue 中仍只有通知 job ID。

不要把 App Secret 粘贴进 Git、文档、普通变量或命令参数。App Secret 在聊天、日志或截图中出现后必须先到飞书开放平台重新生成，再通过交互式 `wrangler secret put FEISHU_APP_SECRET` 或 Cloudflare Dashboard 的加密 Secret 输入框写入。

自建应用测试若返回 `FEISHU_99991672`，表示应用缺少目标消息操作所需权限。确认已启用机器人能力、开通 `im:message:send_as_bot`、发布应用版本，并把目标用户纳入可用范围后再重试。权限完成后，把 Provider 切换为 `feishu_app`，真实测试应在 `notification_jobs` 和 `notification_deliveries` 中形成 `provider=feishu_app`、`status=delivered` 的记录。

只查看状态和数量：

```bash
npx wrangler d1 execute "$D1_NAME" --remote \
  --command "SELECT status, COUNT(*) AS jobs, MIN(created_at) AS oldest_created_at, MAX(updated_at) AS newest_updated_at FROM notification_jobs GROUP BY status ORDER BY status;"
```

流量快照的幂等状态单独查看；不要查询报告正文：

```bash
npx wrangler d1 execute "$D1_NAME" --remote \
  --command "SELECT schedule, status, COUNT(*) AS runs, MAX(updated_at) AS newest_updated_at FROM traffic_report_runs GROUP BY schedule, status ORDER BY schedule, status;"
```

状态含义：

- `staged`：outbox 已写入，但入队尚未确认；每分钟 Cron 会每次最多恢复 10 条。
- `queued`：已入队或等待平台级重试。
- `processing`：consumer 已 claim；45 秒租约过期后可重新 claim。若持久化尝试预算已经耗尽且平台不再投递，Cron 会以 CAS 租约终结该 job，避免永久悬挂。
- `delivered` / `failed`：最终状态；与 `notification_deliveries` 的最终记录一起保留 30 天。

排查顺序：

1. 先确认 Worker deployment 中同时存在 Queue producer 与 consumer，且 Queue 名一致。
2. 查看 Queue backlog、consumer 错误和结构化事件；不要打印消息正文或 D1 设置。
3. `staged` 持续增长通常表示 Queue binding/配额/可用性异常；`queued` 持续增长通常表示 consumer 或 Provider 异常。
4. `missing_credential`、`missing_target`、`invalid_provider_config` 等永久配置错误会直接失败并确认消息；`network_error`、HTTP 408/425/429/5xx 才重试。
5. 每次 Queue 尝试只请求 Provider 一次；同一 D1 job 的持久化总预算不会被重复物理消息重置，延迟为 60、120、240 秒，第四次失败写最终记录并确认，不依赖无限重试或 DLQ。

周期流量快照按 UTC 周期键幂等，设置为每日/每周/每月后会在当前周期首次小时 Cron 发送；默认关闭。`traffic_report_runs` 的 `staged`、`queued`、`delivered`、`failed` 会跟随关联的通知 job 更新，保留 400 天。快照使用每台服务器自己的当前账期累计值和重置日，不代表统一的自然日/周/月增量。

不要手工把 `processing` 改回 `queued`。先等 45 秒租约自然到期；若 Queue 消息仍存在，平台会重新投递；若第四次 claim 后发生内部异常且平台不再投递，Cron 会把过期 job 终结为 `attempt_budget_exhausted`。停用 Queue 前必须先确认没有 `staged` / `processing` job；直接移除 binding 后，Queue 恢复与耗尽预算终结器都会停止。Cloudflare Queues 是 at-least-once，Provider 成功后、D1 batch 提交前的崩溃可能造成重复通知，这是外部 API 无事务能力下的已知边界。

## Workers Logs 与 Traces

### 推荐起点

当需要持久化平台日志时，在 `wrangler.toml` 增加：

```toml
[observability]
enabled = true

[observability.logs]
enabled = true
head_sampling_rate = 0.05
invocation_logs = true
persist = true

[observability.traces]
enabled = true
head_sampling_rate = 0.01
persist = true
```

这是低采样起点，不是所有规模通用的承诺。开启前先用用量面板观察实际 Worker 请求数。本项目的 GitHub Actions 会动态生成 `wrangler.toml`；如决定开启，必须同时修改仓库配置与 `.github/workflows/deploy.yml` 中的生成模板，否则 CI 部署会丢失该配置。

采样原则：

- 平时 Logs 建议 1%–5%，Traces 建议 0.5%–1%。
- 每分钟 Cron、Agent 上报和 WebSocket 会放大事件数；不得默认 100% 持久化。
- 临时故障排查可短时调高采样，处理后当天恢复。
- 2026-10-01 后将 trace span 一并纳入 200,000 events/天预算，上调 Traces 前必须同时检查 Logs 用量。

### 实时排查

持久化 Logs 未开启或采样未命中时，使用带过滤的 Tail：

```bash
npx wrangler tail cf-server-monitor-komari \
  --status error \
  --sampling-rate 0.2 \
  --format pretty
```

对特定路径排查时，优先加 `--method` 或 `--search`，不要长时开启无过滤 Tail。

### 日志脱敏

结构化日志只保留白名单元数据，例如：

```json
{"event":"notification.test.failed","provider":"telegram","attempts":3,"error":"HTTP_503"}
```

禁止记录：

- `Authorization` / Cookie / JWT、用户名和密码。
- `API_SECRET`、Cloudflare API Token、Turnstile Secret。
- 通知 Webhook URL、Bot Token、Chat ID 和外部 API 响应正文。
- Agent 安装命令、完整请求体、D1 设置行和导出内容。

错误日志使用稳定代码（如 `missing_target`、`network_error`、`HTTP_503`），不直接输出未信任异常的完整 message/stack。

## 扩容前用量门禁

开发阶段首个 Worker/D1/DO 用量基线见 [`usage-baseline-2026-08-20.md`](usage-baseline-2026-08-20.md)。它证明当前单节点环境有充足容量，但不等于未来扩容授权。

实际新增节点、缩短 Agent 上报周期或启用高频 PingTask 前：

1. 使用 Cloudflare GraphQL Analytics API 按精确 Worker script、D1 database ID 和 Durable Object namespace 过滤，连续读取此前 7 个完整 UTC 日；不得混入同账户的旧 `cf-komari` 或其他 Worker。
2. Worker requests、D1 rows read/write、DO estimated billable requests 和 DO duration 的单日峰值必须低于对应 Free 额度的 50%。
3. 主 Worker 不得出现 `exceededResources` 或用户可见 5xx；DO hibernation `scriptThrewException` / `internalError` 不得呈增长趋势。
4. 按计划节点数、上报间隔和 PingTask 数量重新计算 D1 写入。10 个 60 秒 PingTask 每节点理论上可新增约 14,400 条结果/日，不能沿用无任务时的线性节点倍数。
5. 若启用 Queue，将 Queue operations/day 单独加入门禁；若部署隔离备份 Workflow，将 Workflow requests、steps、duration、storage 和失败实例加入门禁。
6. 将采集窗口、资源版本、峰值、异常状态和结论追加到新的日期化基线文档，再执行扩容。

该门禁是扩容动作的运维前置条件，不是当前 P1 代码完成条件。资源尚未运行满 7 个完整 UTC 日时，必须等待真实数据产生，不能用零值、预测值或部署前日期代替。

## 每周运维检查

1. 确认 D1 Time Travel 仍可返回当前 bookmark。
2. 确认 `.local-backups/` 未被 Git 跟踪，并按本地保留策略清理旧导出。
3. 检查 Workers Logs/Traces 当日用量和采样率，不将 3 天平台保留误当成长期日志。
4. 查看管理审计和通知投递记录；若启用 Queue，再检查 `notification_jobs` 状态计数，确认没有持续 `staged` / `queued` 积压或 Provider 故障。
5. 若启用私有 R2，确认 `cfsm-logical-backups/` 生命周期仍生效，并抽样下载一份文件验证 manifest SHA-256。
