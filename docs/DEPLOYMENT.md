# 独立测试环境与运维记录

> 最后验证：2026-08-19（Asia/Shanghai）。本文只记录公开资源标识和安全操作边界，不包含任何 Secret、JWT 或 Agent 配置内容。

## 当前基线

- 开发分支：`codex/reboot-foundation`
- CF-Server-Monitor 基线：`a4911ffa8664e047ea672d735a32d8ffde1c01da`
- cfsm-agent：`v1.0.8` / `b435168ab8585aed10801d3e2918ba2fa09342b4`
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
| 已验证 Worker Version | `39cb7d04-a470-4e4b-9800-b1478714da9b` |

`API_SECRET` 已作为 Cloudflare Secret 设置，本机回滚副本保存在 macOS Keychain：

- account: `benbenwu1`
- service: `cf-server-monitor-komari-api-secret`

不要将 Keychain 读取结果打印到终端；只允许通过标准输入或进程变量直接传给 `curl` / `wrangler secret put`。

### TOTP 加密 Secret（启用前必需）

TOTP 代码已经支持独立的 `TOTP_ENCRYPTION_KEY`，但当前线上测试环境未创建或写入该 Secret，TOTP 也未启用。部署代码后，管理员必须先用 Cloudflare 的交互式 Secret 输入配置一个稳定、随机且至少 32 个字符的值：

```bash
npx wrangler secret put TOTP_ENCRYPTION_KEY
```

不要把值作为命令参数、环境普通变量、日志或仓库文件提交。该 Secret 用于派生 AES-GCM 密钥并加密 D1 中的 TOTP secret，同时保护恢复码摘要；一旦启用 TOTP，丢失或直接轮换它会导致现有验证码和恢复码都无法验证。启用前必须在密码管理器或系统密钥链中保存独立回滚副本，轮换前先停用 TOTP，再配置新 Secret 并重新绑定。

### GitHub OAuth（可选，当前未配置）

代码已支持 GitHub OAuth，但当前线上测试环境没有创建 OAuth App、没有配置 Client ID / Client Secret / callback URL，也没有部署本工作包。启用前先在 GitHub 创建只用于登录的 OAuth App：

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

- `/api/config`、`/__do/health`、管理员登录和 JWT 正常。
- Agent HTTP POST 上报正常，节点可在 5 分钟在线阈值内持续保持在线。
- Agent WSS 已临时开启并真实建连成功；验证后恢复 `wss_report_enabled=false`，避免长期占用 DO duration。
- 已修复“运行中关闭 Agent WSS 后 POST 也被 403 退避、无法领取 HTTP 配置”的模式切换死锁；线上复测中 Agent 收到 `409` 后在同一秒通过 POST 切回 `connection_mode=http`。
- `metrics_history` 持续增加，前台和详情页能读取同一批实时/历史数据。
- 电信、联通、移动延迟与丢包率已在 D1 和真实浏览器中出现。`BD` 为可选第四自定义节点，当前留空。
- 1440×900 桌面和 390×844 移动视口无水平溢出；节点详情页 11 个 Chart.js canvas 已渲染。
- 空状态中英文不再混用或重复“请在”。

## 日常核对

D1 Time Travel 恢复、Workers Logs/Traces 采样与脱敏流程见 [`OPERATIONS.md`](OPERATIONS.md)。

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
