# 配置逻辑备份与可选 R2 设计

> 最后核验：2026-08-20（Asia/Shanghai）。面板工作包只实现管理员手动、脱敏的配置导出；完整 D1 定时归档已作为独立子项目完成并随提交 `58aa764` 推送，但尚未部署，仍不提供任意 SQL 或自动恢复。

## 结论

Cloudflare 当前有三种不同目的的恢复/导出能力，不能混为一谈：

| 能力 | 适用场景 | 当前项目决策 |
| --- | --- | --- |
| D1 Time Travel | 同一数据库最近 7 天的误删、错误迁移和原地回滚 | 继续作为事故恢复主路径 |
| `wrangler d1 export` | 运维人员生成含 schema 与数据的完整 SQL 文件 | 继续保留在受控本机运维流程；文件可能含全部凭据 |
| CFSM 配置逻辑备份 | 管理员下载或写入私有 R2 的跨环境配置参考 | 本工作包实现；严格白名单、无自动恢复 |

D1 Worker API 的 `dump()` 不能作为通用实现。Cloudflare 官方文档明确警告：它只适用于 D1 Alpha 期创建的数据库；Production backend 应使用 Time Travel、Wrangler/REST export 等当前能力。

## 官方能力核验

- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)：Production backend 自动开启；Workers Free 可回到最近 7 天，Paid 为 30 天；恢复会原地覆盖数据库。
- [D1 Import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)：`wrangler d1 export --remote` 可导出完整或指定表的 SQL；运行中的导出会阻塞其他数据库请求。
- [D1 Database Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/#dump)：`dump()` 仅支持 Alpha 数据库，不能用于当前通用产品路径。
- [Cloudflare Workflows: Export and save D1 database](https://developers.cloudflare.com/workflows/examples/backup-d1/)：官方示例用 D1 REST export、轮询 signed URL、流式写 R2，且要求具有 D1 export 权限的独立 API Token。
- [R2 Pricing](https://developers.cloudflare.com/r2/pricing/)：Standard storage 每月包含 10 GB-month、100 万次 Class A、1000 万次 Class B，互联网出口免费。
- [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)：Free 每次动态请求为 10 ms CPU、128 MB 内存；因此产品内导出必须保持低频和有界。
- [R2 Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)：可按对象前缀配置过期规则，适合控制长期备份数量。

官方 Workflows 完整导出路径很有价值，但它导出整个 D1，会包含密码哈希、通知凭据、TOTP 密文、Session 和审计等数据，还需要一个能调用 D1 export REST API 的独立 Secret。该路径已在 [`../ops/d1-backup-workflow`](../ops/d1-backup-workflow/README.md) 实现为隔离 Worker/Workflow，并随提交 `58aa764` 推送：Token 不加入公开面板 Worker，SQL 与本工作包的脱敏 JSON 不混用。当前尚未创建资源、写 Secret 或部署。

## 产物契约

格式名为 `cfsm-logical-backup`，当前 `format_version = 1`。顶层包含：

- `manifest`：UTC 生成时间、应用版本、逻辑 schema 版本、记录计数、SHA-256、排除清单和安全警告。
- `data.site_options`：只取非凭据站点设置白名单。
- `data.appearance_options`：站点外观和主题设置。
- `data.servers`：显式列白名单，不使用 `SELECT *`，避免未来新增敏感列时被自动带出。
- `data.ping_tasks` 与 `data.ping_task_assignments`：PingTask 定义和节点分配；不含结果历史。

SHA-256 的输入固定为 UTF-8 编码的 `JSON.stringify(backup.data)`。R2 对象同时把该值写入 `data_sha256` custom metadata，下载文件内的 manifest 仍是最终校验依据。

### 明确排除

- `API_SECRET`、环境变量、Worker Secret 和 GitHub OAuth Client Secret。
- 管理员用户名、密码哈希、JWT Secret、Turnstile Secret、Cloudflare Token/Account ID、通知 Token/Chat ID。
- TOTP secret、恢复码、pending setup，以及 OAuth identity/state/交换码。
- Session、二次验证限流、登录限流、审计、通知投递记录、通知 Queue outbox/job 状态和流量快照运行记录。
- `metrics_history*`、`ping_task_results` 和资源告警运行态。

配置文件仍可能包含管理员自己写入的服务器内部备注、服务器 ID 和探测目标，因此必须作为私密文件保存，不能公开到静态站点、GitHub Artifact 或公共 R2 域名。

## 运行边界

- 最多 5000 台服务器。
- 最多 50000 条 PingTask 分配关系。
- 最终 pretty JSON 最多 1 MiB，避免管理员导出在 Workers Free 的 10 ms CPU / 128 MB 边界上无界放大。
- 只允许已登录管理员调用；下载与 R2 写入分别记录 `admin.backup.export` 和 `admin.backup.r2_create` 审计。
- `BACKUP_BUCKET` 不存在时，状态接口返回不可用，R2 操作按钮关闭；下载、Worker 启动、Agent 上报和其他管理能力不受影响。
- R2 对象固定写入私有 binding，代码不创建 `r2.dev` 公共域名，也不返回可公开访问的 URL。

## 为什么暂不恢复

当前文件是配置参考，不是事务快照。安全恢复至少还需要：

1. 严格校验每个字段、外键、服务器 ID、PingTask 容量和 schema 兼容范围。
2. 明确 merge、replace、ID 冲突和历史分区重分配语义。
3. 恢复前创建完整 SQL/Time Travel 回滚点，并在维护窗口暂停 Agent 写入。
4. 对大文件、重复项、旧版本和部分失败提供原子策略。

在这些条件没有单独设计和测试前，任何自动上传恢复端点都比手动重建更危险，因此 manifest 明确标记 `restorable_by_application = false`。
