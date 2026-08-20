# 隔离的 D1 全量备份 Workflow

该子项目把 CF-Server-Monitor 的完整 D1 SQL 导出到专用私有 R2。它是独立 Worker/Workflow，不属于面板 Worker，不读取面板的 `API_SECRET`，也不会把高权限 D1 REST Token 注入公开面板。

当前状态：代码、测试和配置模板已在本地完成；尚未创建 R2、API Token 或 Workflow，尚未写入 Secret，也尚未部署。

## 安全边界

- `D1_REST_API_TOKEN` 只能通过本组件的 Worker Secret 注入，不得放进 `vars`、`.dev.vars`、Git、日志或 manifest。
- R2 bucket 必须保持私有；不要开启 `r2.dev`，不要绑定公共自定义域名。
- 默认 HTTP handler 始终返回 404。定时触发直接挂在 Workflow binding 的 `schedules` 上，没有公网手工触发入口。
- Queue、面板 Worker、旧 Komari Agent 和旧 Cloudflare 资源均不参与这条链路。
- 完整 SQL 会包含 D1 中的密码哈希、通知凭据、TOTP 密文、Session、审计和历史数据，必须按敏感生产备份处理。
- 本组件只生成备份，不自动恢复，不会自动修改生产 D1。

## 工作流

每天 19:17 UTC（北京时间次日 03:17）创建一个 Workflow 实例：

1. 校验非 Secret 配置和独立 Secret/binding 是否存在，生成稳定的 UTC 对象键。
2. 调用 D1 REST export，取得固定 bookmark。
3. 轮询同一 bookmark，最多 30 次、每分钟一次，等待一次性 signed URL。
4. 把 SQL 响应体直接流式写入 R2；对象键包含 Workflow instance ID，重试不会覆盖其他备份。
5. 写入小型 JSON manifest，记录 SQL key、bookmark、字节数、ETag，以及 R2 可用时返回的 MD5。

SQL 下载和 R2 `put()` 故意处于同一个 durable step。Cloudflare Workers Free 当前每个 Workflow 实例最多持久化 100 MB 状态；若先把 dump 作为 step 输出保存，大数据库会在写 R2 前耗尽状态额度。流式直传不把 SQL 放进普通 JSON step 结果，也不在内存中整体缓冲。

对象格式：

```text
cfsm-d1-full-backups/YYYY/MM/DD/<workflow-instance-id>.sql
cfsm-d1-full-backups/YYYY/MM/DD/<workflow-instance-id>.manifest.json
```

manifest 不包含 API Token、D1 database ID 或 signed URL。外部 API 和 R2 都没有跨系统事务；如果导出启动请求已成功但响应在返回前中断，D1 可能短暂存在额外导出任务。最终对象键仍按实例幂等。

## 本地验证

仓库根目录已经安装 Wrangler 时可直接执行：

```bash
cd ops/d1-backup-workflow
npm test
cd ../..
npx wrangler deploy --dry-run \
  --config ops/d1-backup-workflow/wrangler.test.toml
```

`wrangler.test.toml` 只有不可用的占位资源名，只用于 bundling/schema 验证，禁止部署。

## 首次部署清单

以下命令会创建或修改远端资源，只能在取得明确上线授权后执行。本地开发完成并不代表这些步骤已经运行。

1. 复制模板并替换 Account ID、D1 UUID、公开标签和私有 bucket 名：

   ```bash
   cd ops/d1-backup-workflow
   cp wrangler.toml.example wrangler.toml
   ```

2. 创建只用于完整备份的 R2 bucket。新 bucket 默认私有；创建后仍需在 Dashboard 确认没有 `r2.dev` 和自定义域名：

   ```bash
   npx wrangler r2 bucket create your-cfsm-d1-full-backups
   ```

3. 为 `cfsm-d1-full-backups/` 设置 30 天生命周期，并复核规则：

   ```bash
   npx wrangler r2 bucket lifecycle add \
     your-cfsm-d1-full-backups \
     cfsm-d1-full-backups-30d \
     cfsm-d1-full-backups/ \
     --expire-days 30
   npx wrangler r2 bucket lifecycle list your-cfsm-d1-full-backups
   ```

4. 在 Cloudflare Dashboard 创建独立 API Token。使用账户级 `D1 Read`，Account Resources 只包含目标账户，不附加 Workers、R2、DNS 或其他权限。Cloudflare 的 export API 文档没有提供更细的单数据库 token scope；因此不要把该 Token 复用于别的服务。若当前平台返回 403，先重新核对官方 export 权限定义和 Token 审计，不要直接扩大到全账户管理权限。

5. 交互式写入本组件的 Secret。不要把值放到命令参数或 shell 历史：

   ```bash
   npx wrangler secret put D1_REST_API_TOKEN --config wrangler.toml
   ```

6. 再次测试、dry-run，确认 binding 列表只含本 Workflow、私有 R2 和四个非 Secret 变量，然后部署：

   ```bash
   npm test
   npx wrangler deploy --dry-run --config wrangler.toml
   npx wrangler deploy --config wrangler.toml
   ```

D1 export 运行时数据库可能暂时无法查询。默认时间只是北京时间用户的低峰建议；若站点主要用户处于其他时区，应先改 `schedules`，再部署。

## 运行状态

查看 Workflow 与最近实例：

```bash
npx wrangler workflows list --config wrangler.toml
npx wrangler workflows instances list cfsm-d1-full-backup \
  --config wrangler.toml --reverse
npx wrangler workflows instances describe cfsm-d1-full-backup latest \
  --config wrangler.toml
```

需要经过 Cloudflare 身份验证的人工演练时，可由 Wrangler 创建实例；这不是公网 API：

```bash
npx wrangler workflows trigger cfsm-d1-full-backup \
  --config wrangler.toml
```

日志和错误只应出现安全错误码。排查时不要打开 step output 打印 signed URL，也不要记录 Authorization header。

## 下载、校验与恢复

先从 manifest 取得 SQL key，再下载两个私有对象：

```bash
mkdir -p ../../.local-backups
npx wrangler r2 object get \
  'your-cfsm-d1-full-backups/cfsm-d1-full-backups/YYYY/MM/DD/INSTANCE.manifest.json' \
  --remote --file ../../.local-backups/INSTANCE.manifest.json
npx wrangler r2 object get \
  'your-cfsm-d1-full-backups/cfsm-d1-full-backups/YYYY/MM/DD/INSTANCE.sql' \
  --remote --file ../../.local-backups/INSTANCE.sql
```

manifest 的 `object.checksums.md5` 非空时，先用它检查 R2 下载是否完整；macOS 使用 `md5 -q`，Linux 使用 `md5sum`。随后计算 SHA-256，并把 `.sha256` 与 SQL 放在同一受控备份介质中：

```bash
md5 -q ../../.local-backups/INSTANCE.sql
shasum -a 256 ../../.local-backups/INSTANCE.sql \
  > ../../.local-backups/INSTANCE.sql.sha256
shasum -a 256 -c ../../.local-backups/INSTANCE.sql.sha256
```

Workflow 不为 SHA-256 缓冲整份 SQL，以免突破 10 ms CPU/128 MB Worker 内存；R2 返回的 MD5/ETag 是自动传输校验，SHA-256 是下载后的长期保管校验。

恢复必须进入维护窗口，暂停 Agent 写入，并优先导入一个全新的 D1 数据库进行验证：

```bash
npx wrangler d1 create cfsm-restore-YYYYMMDD
npx wrangler d1 execute cfsm-restore-YYYYMMDD --remote \
  --file ../../.local-backups/INSTANCE.sql
npx wrangler d1 execute cfsm-restore-YYYYMMDD --remote \
  --command 'SELECT COUNT(*) AS servers FROM servers;'
```

验证 schema、管理员登录、节点、通知设置和样本数据后，才在受控部署中切换 D1 binding。不要把完整 dump 直接导入仍在写入的生产库，也不要把恢复命令加入 Cron、Workflow 或 GitHub Actions。更完整的事故流程见仓库根目录的 `docs/OPERATIONS.md`。

## 官方依据

- [Cloudflare Workflows: Export and save D1 database](https://developers.cloudflare.com/workflows/examples/backup-d1/)
- [D1 REST export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)
- [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
