# Cloudflare 运维手册

> 最后核验：2026-08-19。本文只使用公开资源名和占位符，不应粘贴 API Token、`API_SECRET`、JWT、通知凭据或数据库中的 Secret。

## 能力边界

- D1 Time Travel 在 Workers Free 上保留 7 天，用于同一数据库的短期原地回滚。它不是可下载、可跨账户的备份。
- Workers Logs 是短期故障定位工具；Free 为 200,000 observability events/天，保留 3 天。
- Workers Traces 用于分析 Worker、Durable Object 和 D1 链路。2026-10-01 起，每个 span 作为一个 observability event，与 Logs 共用上述额度。
- Logs/Traces 可能被采样且会自动过期，不得代替 `audit_events` 中的产品安全审计。

官方原文：

- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers Traces](https://developers.cloudflare.com/workers/observability/traces/)

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

### 完整 D1 归档仍走独立路径

配置逻辑备份不替代第 3 步的 `wrangler d1 export`。Cloudflare 还提供 [D1 REST export + Workflows + R2 官方示例](https://developers.cloudflare.com/workflows/examples/backup-d1/)，但它需要具有 D1 export 权限的 API Token，并会导出整个数据库。若以后启用，应使用独立 Worker、独立最小权限 Secret 和私有 R2，不把 Token 放进当前面板 Worker；当前没有部署该组件。

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

## 每周运维检查

1. 确认 D1 Time Travel 仍可返回当前 bookmark。
2. 确认 `.local-backups/` 未被 Git 跟踪，并按本地保留策略清理旧导出。
3. 检查 Workers Logs/Traces 当日用量和采样率，不将 3 天平台保留误当成长期日志。
4. 查看管理审计和通知投递记录，确认没有持续登录失败或 Provider 故障。
5. 若启用私有 R2，确认 `cfsm-logical-backups/` 生命周期仍生效，并抽样下载一份文件验证 manifest SHA-256。
