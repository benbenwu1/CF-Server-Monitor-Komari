# 独立测试环境与运维记录

> 最后验证：2026-08-18（Asia/Shanghai）。本文只记录公开资源标识和安全操作边界，不包含任何 Secret、JWT 或 Agent 配置内容。

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
