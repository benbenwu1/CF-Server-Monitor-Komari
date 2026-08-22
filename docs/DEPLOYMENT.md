# 独立测试环境与运维记录

> 线上最后验证：2026-08-21（Asia/Shanghai）；Git 状态同步：2026-08-21。本文只记录公开资源标识和安全操作边界，不包含任何 Secret、JWT 或 Agent 配置内容。

## 当前基线

- 开发分支：`codex/reboot-foundation`
- CF-Server-Monitor 基线：`a4911ffa8664e047ea672d735a32d8ffde1c01da`
- cfsm-agent 测试节点：正式版 `v1.0.10` / `49b8d05`；稳定回滚版本仍为 `v1.0.8`
- Komari 功能参考：`da4d5187c1b10da3c5893595c5e2a9fd54d13792`

## Cloudflare 资源

| 资源 | 当前值 |
| --- | --- |
| Worker | `cf-server-monitor-komari` |
| 公开 URL | <https://cf-server-monitor-komari.jinyong2006.workers.dev> |
| D1 | `cf-server-monitor-komari-db` |
| D1 ID | `fc52eab7-4134-4a12-bb2f-8777df48f89a` |
| Durable Object | `MetricsBroadcaster` |
| Cron | `*/1 * * * *` 和 `0 * * * *` |
| 已验证 Worker Version | `95e0e7c1-5196-4038-94a3-0ad24bc4d799` |

`API_SECRET` 已作为 Cloudflare Secret 设置，本机回滚副本保存在 macOS Keychain：

- account: `benbenwu1`
- service: `cf-server-monitor-komari-api-secret`

不要将 Keychain 读取结果打印到终端；只允许通过标准输入或进程变量直接传给 `curl` / `wrangler secret put`。

### TOTP 加密 Secret（启用前必需）

TOTP 代码已部署并支持独立的 `TOTP_ENCRYPTION_KEY`，但当前线上测试环境未创建或写入该 Secret，TOTP 也未启用。启用前，管理员必须先用 Cloudflare 的交互式 Secret 输入配置一个稳定、随机且至少 32 个字符的值：

```bash
npx wrangler secret put TOTP_ENCRYPTION_KEY
```

不要把值作为命令参数、环境普通变量、日志或仓库文件提交。该 Secret 用于派生 AES-GCM 密钥并加密 D1 中的 TOTP secret，同时保护恢复码摘要；一旦启用 TOTP，丢失或直接轮换它会导致现有验证码和恢复码都无法验证。启用前必须在密码管理器或系统密钥链中保存独立回滚副本，轮换前先停用 TOTP，再配置新 Secret 并重新绑定。

### GitHub OAuth（可选，当前未配置）

GitHub OAuth 代码已部署，但当前线上测试环境没有创建 OAuth App，也没有配置 Client ID / Client Secret / callback URL，因此入口保持不可用。启用前先在 GitHub 创建只用于登录的 OAuth App：

1. Authorization callback URL 精确填写 `https://<Worker 域名>/admin/oauth/github/callback`。
2. 关闭该 callback 的 wildcard matching。2026-08-03 之前创建且原来只有一条 callback 的旧 App 可能被迁移为 wildcard 开启，必须主动复核。
3. 不申请 `repo`、`user`、`user:email` 或其他 scope；本项目只用无 scope 的 `GET /user`，并以不可变 numeric `id` 识别管理员。
4. 一个 OAuth App 当前最多配置 10 条 callback。开发、测试和生产优先使用独立 App，不共享 Client Secret。

Worker 需要三项绑定：

| 名称 | 类型 | 示例/说明 |
| --- | --- | --- |
| `GITHUB_OAUTH_CLIENT_ID` | 普通变量 | GitHub OAuth App 的公开 Client ID，可出现在浏览器 authorize URL。 |
| `GITHUB_OAUTH_CALLBACK_URL` | 普通变量 | 与 GitHub App 中完全一致的固定 HTTPS callback；本地 `localhost` / `127.0.0.1` 调试可用 HTTP。 |
| `GITHUB_OAUTH_CLIENT_SECRET` | Worker Secret | 只能通过 Cloudflare Secret binding 注入，不得写进 `wrangler.toml`、`.env`、日志或仓库。 |

普通变量可在 Cloudflare Dashboard 的 Worker Settings 中设置，或在受控部署配置中声明。Client Secret 只能交互式写入：

```bash
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
```

当前 Wrangler 的 `secret put` 会创建新 Worker 版本并立即部署，因此不要把它当成本地测试命令；必须在取得上线授权后执行。本任务没有运行该命令。Secret 轮换会使尚未完成的 5 分钟 OAuth 流程失效，但不会删除既有 GitHub numeric ID 绑定。

若管理前端部署在 GitHub Pages 或其他独立域名，还要把该前端的精确 origin 加入 `CORS_ALLOWED_ORIGINS`。OAuth 完成页固定为 `/admin#admin`；callback 只把 60 秒一次性交换码放入 URL fragment，前端会先清除 fragment，再向 `oauth_api` 指定且已配置的 Worker 交换本地 JWT。JWT、GitHub token、Client Secret 和 PKCE verifier 都不会进入 callback URL。

首次启用步骤：先用密码登录管理页，在“设备会话”中绑定 GitHub；未绑定前，任何匿名 GitHub callback 都不能取得管理员权限。若已启用 TOTP，绑定、GitHub 登录和解绑都必须再验证 TOTP 或一次性恢复码。解绑会撤销所有 `github_oauth*` Session，但不会撤销密码 Session。

### 私有 R2 配置逻辑备份（可选）

本功能不要求 R2。没有 `BACKUP_BUCKET` binding 时，管理页仍可下载逻辑备份，Worker、Agent 上报和其他管理能力不受影响。

需要私有 R2 时，由运维人员先创建专用 bucket；不要启用 `r2.dev` 或公共自定义域名：

```bash
npx wrangler r2 bucket create your-cfsm-private-backups
```

本地/手工部署时在 `wrangler.toml` 增加：

```toml
[[r2_buckets]]
binding = "BACKUP_BUCKET"
bucket_name = "your-cfsm-private-backups"
```

GitHub Actions 部署时不要把 bucket 名写入 Secret。到仓库 Settings → Secrets and variables → Actions → Variables 新建普通变量：

```text
R2_BACKUP_BUCKET=your-cfsm-private-backups
```

现有 workflow 仅在变量非空且符合 R2 bucket 命名规则时附加 binding。变量为空时不会声明或创建 R2 资源。

建议按 `cfsm-logical-backups/` 前缀设置 90 天生命周期；先核对目标 bucket，再执行会改变远端配置的命令：

```bash
npx wrangler r2 bucket lifecycle add \
  your-cfsm-private-backups \
  cfsm-logical-backups-90d \
  cfsm-logical-backups/ \
  --expire-days 90
```

该 JSON 明确排除产品已知凭据和运行历史，但仍可能包含服务器内部备注、ID 和 PingTask 目标。详见 [`logical-backup-2026.md`](logical-backup-2026.md)。当前不支持把它自动恢复到 D1。

### 隔离 D1 全量备份 Workflow（可选，当前未部署）

完整 SQL 归档已经在 [`ops/d1-backup-workflow`](../ops/d1-backup-workflow/README.md) 中作为独立子项目实现。它不随面板 Worker 或 GitHub Actions 自动部署，也不使用面板的 Secret/binding。当前没有创建专用 R2、D1 REST API Token 或 Workflow，没有执行 `secret put`，线上版本不受影响。

启用时必须满足以下边界：

- 复制该目录的 `wrangler.toml.example` 为被 Git 忽略的 `wrangler.toml`，只填写非 Secret 标识。
- 新建专用私有 R2，不开启 `r2.dev` 或公共自定义域名；建议对 `cfsm-d1-full-backups/` 设置 30 天生命周期。
- 为目标账户创建仅含 D1 导出所需读权限的独立 Token，并交互式写入该 Worker 的 `D1_REST_API_TOKEN` Secret。
- 默认 schedule 为每天 19:17 UTC。D1 export 期间数据库可能暂时无法查询，部署前必须确认这确实是站点低峰。
- 先运行子项目 13 项 Node 测试和独立 Wrangler dry-run，再取得上线授权；不得把该组件追加到面板的 `deploy.yml`。
- manifest 记录 SQL key、bookmark、字节数、ETag 和 R2 可用时返回的 MD5，但不记录 Token、database ID 或 signed URL；组件永不自动恢复生产 D1。

资源创建、Secret、Workflow 状态、私有对象下载、SHA-256 长期校验和新 D1 演练恢复的完整命令均在子项目 README 中。根项目运维边界见 [`OPERATIONS.md`](OPERATIONS.md)。

### 通知 Queue（可选，当前已启用）

通知 Queue 已于 2026-08-22 部署到独立测试环境。专用 Queue 为 `cf-server-monitor-komari-notifications`，Queue ID 为 `9384c3c58017473e99e49551a0f592d9`；Worker Version `957953be-4b36-4a6d-92a9-ebe549821438` 同时声明 `NOTIFICATION_QUEUE` producer 与 consumer，GitHub Actions 普通变量 `NOTIFICATION_QUEUE_NAME` 已设置为同名 Queue。流量快照仍为 `off`，验收后 `notification_jobs` 和 `traffic_report_runs` 均为 0。管理员“测试通知”继续保持同步。

启用前先在目标账户创建专用 Queue；Queue 名不是 Secret：

```bash
npx wrangler queues create cf-server-monitor-komari-notifications
```

本地或手工部署时，取消 `wrangler.toml` 中 Queue 示例的注释；producer 与 consumer 必须同时指向同一 Queue：

```toml
[[queues.producers]]
binding = "NOTIFICATION_QUEUE"
queue = "cf-server-monitor-komari-notifications"

[[queues.consumers]]
queue = "cf-server-monitor-komari-notifications"
max_batch_size = 5
max_batch_timeout = 1
max_retries = 3
retry_delay = 60
max_concurrency = 1
```

GitHub Actions 部署时，在仓库 Actions Variables 新建普通变量：

```text
NOTIFICATION_QUEUE_NAME=cf-server-monitor-komari-notifications
```

变量为空时 workflow 不声明 Queue，Worker 保持兼容；变量非空前必须先创建 Queue。不要把通知 Provider Token、Chat ID 或 Webhook 写入 Queue 变量、`wrangler.toml` 或 GitHub 配置，它们仍只保存在现有 D1 设置中。Queue 消息只有 `{version, job_id}`，consumer 执行时再读取当前设置。

本次部署前 D1 Time Travel bookmark 为 `00000012-000003f6-000050cf-7eeee07b791f6ab4ab84720ca79d6cec`。Wrangler 4.120.0 与 4.125.0 均没有 `queues message send` 子命令，因此无害探测改用 Cloudflare 官方 Queue Push Message API，只发送 `{version: 1, job_id: "00000000-0000-4000-8000-000000000000"}`。API 接受消息后，consumer 对不存在的 job 正常确认；D1 未新增通知任务或流量快照记录，也没有触发外部通知。

Workers Free 当前每天包含 10,000 Queue operations，一条小消息成功写入、读取、删除通常约 3 operations，且 Free 消息保留固定 24 小时。本实现只承接低频控制面告警和可选流量快照，不中转 Agent 指标或 PingTask 结果。同一 D1 job 共享初始投递加最多 3 次重试的持久化总预算，重复物理消息不会重置计数；outbox 还负责 staged 恢复。外部 Provider 仍是 at-least-once，极端崩溃窗口可能重复通知。

流量快照可在管理页选择关闭、每日、每周或每月。周期按 UTC 计算，启用后会在当前周期首次小时 Cron 时发送；每个周期键只处理一次。内容是各服务器 Agent 上报的当前账期累计值，最多展开 50 台，并不是自然日/周/月增量；因为每台服务器可配置不同流量重置日，不能把该快照误读为统一结算周期。

### Komari 只读聚合告警

Worker Version `95e0e7c1-5196-4038-94a3-0ad24bc4d799` 增加了对现有生产 Komari 公开 RPC 的只读轮询。数据源通过普通变量 `KOMARI_MONITOR_URL=https://vps.i404.dev` 配置，不读取 Komari 管理员 Session、Token、节点 Secret 或远程终端能力，也不修改 Komari 数据。

当前覆盖 Komari 中 4 台 VPS。每分钟 Cron 检查：连续离线 3 分钟、三网平均延迟超过 200ms 或丢包超过 10% 持续 5 分钟、流量使用达到 80% 后每增加 5%，以及有效期进入最后 7 天。每天 00:00 UTC（北京时间 08:00）生成一条汇总，包含在线状态、已用/总量/剩余流量、三网延迟/丢包和有效期。所有消息复用 `NOTIFICATION_QUEUE`，运行状态保存在 D1 `settings.komari_monitor_state_v1`，不保存 Komari 凭据。

飞书 Webhook 当前尚未配置，因此该监控会安全返回 `missing_notification_credential`，不请求 Komari、不产生 Queue 消息。配置飞书机器人后才开始真实轮询和通知。

### Analytics Engine 影子遥测（可选，当前未启用）

P2 影子遥测代码已随 Worker Version `7194c8c8-aa16-4bdf-91bd-cb311d20beb3` 部署，但当前未声明 `CFSM_ANALYTICS` binding，因此所有写入函数立即返回，线上没有 Analytics Engine 数据写入。Analytics Engine 的 `writeDataPoint()` 是同步非阻塞调用，不需要 `waitUntil()`。

本地或手工部署时，可在 `wrangler.toml` 增加：

```toml
[[analytics_engine_datasets]]
binding = "CFSM_ANALYTICS"
dataset = "cfsm_shadow_telemetry"
```

GitHub Actions 部署时设置普通变量：

```text
ANALYTICS_ENGINE_DATASET=cfsm_shadow_telemetry
```

首期只写请求级匿名聚合：固定 index、低基数路由类别、HTTP 方法、结果类别、状态码、耗时和计数。禁止写入原始 path、查询串、IP、Server ID、JWT、Cookie、Agent Secret 或通知凭据。写入异常被安全隔离，不得改变请求结果。启用后先运行 14 天，与 D1/Cloudflare GraphQL 现有统计对比，再决定是否增加管理图表；它不替代 D1、审计表、通知 outbox 或精确账单。

## 真实测试节点

| 项目 | 当前值 |
| --- | --- |
| 名称 | `jp-cfsm-test` |
| Server ID | `bd6173bf-7f19-4f40-be53-37c8b86708ee` |
| 远程别名 | `ssh cloud` |
| 系统 | Debian 12 / amd64 / systemd |
| Agent | `/usr/local/bin/cf-probe` |
| 服务 | `cf-probe.service` |
| 配置 | `/etc/config/cf-probe/config.conf` |
| 自动更新 | 关闭，避免测试基线漂移 |

Agent 发布资产 `cf-probe-linux-amd64` 在安装前已校验 SHA-256：

```text
0e755ab70f10f4f539d1194a2d7d603f9123e7e907f1defe6cfda9f3bd927c17
```

## 已验证链路

- 2026-08-22 只读 Komari 聚合监控部署为 Worker Version `95e0e7c1-5196-4038-94a3-0ad24bc4d799`；绑定中新增普通变量 `KOMARI_MONITOR_URL`，保留 D1、DO、Assets 和通知 Queue，未增加 R2 或 Analytics Engine。104 项 Node 测试、Agent 配置测试、生产构建、依赖审计和 Queue 配置 dry-run 全部通过。
- Komari 公开 RPC 当前返回 4 台 VPS：3 台设置为 500 GiB 流量额度，阿里云广州节点未设置流量上限；有效期分别为 2026-09-14、2026-11-12、2026-12-26、2026-11-26。新面板现有 `jp-cfsm-test` 已确认对应 `IIJ-HostYun`，并同步为 500 GiB、每月 1 日重置、2026-09-14 到期。
- 2026-08-22 Queue 部署使用代码基线 `7179aa37d9e0e1f44fe3070348562f5b742d5aae`；Worker Version `957953be-4b36-4a6d-92a9-ebe549821438` 于 01:05 UTC 接管 100% 流量。版本只增加 `NOTIFICATION_QUEUE`，保留 `API_SECRET`、D1、Durable Object、Assets 和两个 Cron，未声明 `BACKUP_BUCKET` 或 `CFSM_ANALYTICS`。
- 专用 Queue `cf-server-monitor-komari-notifications` / `9384c3c58017473e99e49551a0f592d9` 验收时为 producer=1、consumer=1；GitHub Actions 普通变量已读回为同名 Queue。无害 opaque job 探测被 API 接受并由 consumer 消费，`notification_jobs=0`、`traffic_report_runs=0`，`traffic_report_schedule=off`。
- Queue 部署后 `/`、`/api/config` 和 `/__do/health` 均返回 200；从部署时间起的 GraphQL 窗口内 Worker 16 次、DO 9 次 invocation 全部 success、errors=0。测试 Agent 保持 active/enabled、`v1.0.10` 和原 SHA-256，D1 最新指标推进到 `2026-08-22T01:11:12.588Z`，静态字段仍为 `cpu_physical_cores=1`、`virtualization=kvm/guest`。
- Git 提交 `6afe512b2948c9188a82649d0f197ecfd5403562` 对应的 Worker Version `7194c8c8-aa16-4bdf-91bd-cb311d20beb3` 于 2026-08-21 04:36 UTC 接管 100% 流量。部署前 D1 Time Travel bookmark 为 `0000000d-000000f2-000050ce-4836bd5575033ef6ad3bfe452f1a2ef7`。
- 该 2026-08-21 版本只声明现有 `API_SECRET`、D1、Durable Object 和 Assets；当时尚未声明 `NOTIFICATION_QUEUE`、`BACKUP_BUCKET` 或 `CFSM_ANALYTICS`，也未创建项目专用 Queue、R2 或 Workflow。
- 该 2026-08-21 版本的 `/`、`/api/config` 和 `/__do/health` 均返回 200；部署后 15 分钟 GraphQL 窗口内 5 次 invocation 全部成功、errors=0。
- `servers` 已自动增加 `cpu_physical_cores INTEGER DEFAULT 0` 和 `virtualization TEXT DEFAULT ''`；旧 Agent `v1.0.8` 继续兼容，因此当前值仍为 `0` / 空字符串。
- D1 `metrics_history` 从部署前 4,336 行、最新 `2026-08-21T04:28:35.976Z` 增至 4,345 行、最新 `2026-08-21T04:37:39.027Z`，证明旧 Agent HTTP 上报在新版本接管后继续成功。
- 测试节点先升级到 Agent RC。初版 RC1 在该 Debian/KVM 环境中遇到 gopsutil 返回 `system="" role="guest"`，导致虚拟化类型为空；提交 `49b8d05` 增加 `systemd-detect-virt` fallback，同一红灯命令由 `expected=kvm/guest actual=` 转为 `expected=kvm/guest actual=kvm/guest`。
- 正式 Release [`v1.0.10`](https://github.com/benbenwu1/cfsm-agent/releases/tag/v1.0.10) 精确指向 `49b8d05`，包含 16 个平台二进制和 `checksums.txt`。因 fork 的 Actions API 未注册 workflow，本次按 `release.yml` 同一矩阵本地干净构建并手工上传；Linux amd64 Release 资产 SHA-256 为 `02342c18ec89a642e95b560d562661f3d0b6aea8ad5dcf5b7e39ba87d0dac8d8`。
- 测试节点已切换到正式 `v1.0.10`。D1 与公开 API 均返回 `cpu_physical_cores=1`、`virtualization=kvm/guest`、`agent_version=v1.0.10`；`metrics_history` 最新验证记录为 `2026-08-21T10:45:45.080Z`。最近 15 分钟 Worker 26 次、DO 20 次 invocation 全部 success、errors=0。
- 测试节点保留三个可执行回滚副本：`/usr/local/bin/cf-probe.backup-20260821T080708Z`（v1.0.8）、`/usr/local/bin/cf-probe.backup-20260821T084458Z-rc1` 和 `/usr/local/bin/cf-probe.backup-20260821T104243Z-rc2`；上传到 `/tmp` 的诊断、RC 和正式版文件已清理。
- `/` 与 `/admin` 均返回 `200 text/html`；线上版本保留 `API_SECRET` Secret、D1、Durable Object、Assets 和两个 Cron，未声明 `BACKUP_BUCKET`。
- 配置逻辑备份状态接口未认证时返回 401；密码登录后返回 `scope=configuration-only`、`restore_supported=false`、`r2_available=false`。
- 线上实际导出 `cfsm-logical-backup` v1 成功，产物 3150 字节，包含 1 台服务器、0 个 PingTask；重新计算 `JSON.stringify(backup.data)` 的 SHA-256 与 manifest 完全一致。
- 未绑定 R2 时，写入请求稳定返回 `400 logicalBackupR2Unavailable`；验证产生的临时 curl Session 已全部服务端撤销。
- 部署后 `/api/servers` 返回 1 台服务器，最近上报距检查时约 35 秒；D1 `metrics_history` 最新时间为 `2026-08-19T09:54:10.121Z`，证明真实 Agent HTTP 上报未被 P1 部署打断。
- `/api/config`、`/__do/health`、管理员登录和 JWT 正常。
- Agent HTTP POST 上报正常，节点可在 5 分钟在线阈值内持续保持在线。
- Agent WSS 已临时开启并真实建连成功；验证后恢复 `wss_report_enabled=false`，避免长期占用 DO duration。
- 已修复“运行中关闭 Agent WSS 后 POST 也被 403 退避、无法领取 HTTP 配置”的模式切换死锁；线上复测中 Agent 收到 `409` 后在同一秒通过 POST 切回 `connection_mode=http`。
- `metrics_history` 持续增加，前台和详情页能读取同一批实时/历史数据。
- 电信、联通、移动延迟与丢包率已在 D1 和真实浏览器中出现。`BD` 为可选第四自定义节点，当前留空。
- 1440×900 桌面和 390×844 移动视口无水平溢出；节点详情页 11 个 Chart.js canvas 已渲染。
- 空状态中英文不再混用或重复“请在”。

## 日常核对

D1 Time Travel 恢复、Workers Logs/Traces 采样与脱敏流程见 [`OPERATIONS.md`](OPERATIONS.md)。首个 Worker/D1/DO 实际用量快照和扩容前 7 日观察门禁见 [`usage-baseline-2026-08-20.md`](usage-baseline-2026-08-20.md)。

```bash
npx wrangler whoami
npx wrangler versions list
npx wrangler d1 execute cf-server-monitor-komari-db --remote \
  --command "SELECT server_id, COUNT(*) AS rows, MAX(timestamp) AS last_ts FROM metrics_history GROUP BY server_id;"
ssh cloud 'systemctl is-enabled cf-probe && systemctl is-active cf-probe'
ssh cloud 'journalctl -u cf-probe --no-pager -n 80'
```

上线前依次执行：

```bash
npm ci
npm run build:frontend
npm run test:agent-config
node --test test/*.test.js
npm audit --audit-level=high
npx wrangler deploy --dry-run
```

## 不可跨越的边界

- 不修改或停止 `https://vps.i404.dev` 及其 Komari Agent。
- 不删除旧 Cloudflare 资源 `cf-komari-worker` / `cf-komari-db`。
- 不停止日本测试机上仍在运行的 `komari-agent-patched3`。
- 不读取、复制或迁移旧项目的 token、数据库和 Agent 配置。
- `upstream` 只允许 fetch；不向上游推送。
- 当前改动只推送 `codex/reboot-foundation`，未经确认不合并 `main`。
- 不把 D1 REST export 所需的高权限 API Token 加入当前面板 Worker；若以后采用官方 Workflows 完整归档，必须作为独立备份组件部署。
