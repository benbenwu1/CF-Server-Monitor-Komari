# GitHub OAuth 官方资料核验与 P1 设计约束

> 核验日期：2026-08-18（Asia/Shanghai）。本文只使用 GitHub Docs 与 Cloudflare Developers 官方一手资料，面向 GitHub.com OAuth App 的单管理员登录；不涉及 GitHub Enterprise Server、仓库授权或通用 OIDC。研究期间没有创建 OAuth App、Cloudflare Secret 或任何线上资源，也没有读取本机 Secret。

## 结论

GitHub OAuth App 可以在 Cloudflare Worker 上实现本项目的单管理员登录。推荐使用 Authorization Code Web Flow，同时启用不可猜测的 `state` 和 S256 PKCE；OAuth App 的 `client_secret` 仍须由 Worker 作为机密客户端提交。身份只绑定 `GET /user` 返回的不可变数字 `id`，不使用可能改变的 `login`，也不使用可能为空或改变的 email。

本项目只需要 GitHub 公开身份，因此不请求 OAuth scope，不调用 `/user/emails`，不保存 GitHub access token 或 refresh token。GitHub token 仅在回调处理期间用于读取一次 `/user`，随后从内存丢弃。OAuth 成功不能绕过本地 TOTP：已启用 TOTP 时，必须完成本地 TOTP 或恢复码验证后才创建 `admin_sessions` 和签发本项目 JWT。密码登录继续保留为应急入口。

## 当前项目上下文

- 当前密码登录在 [`src/handlers/admin.js`](../src/handlers/admin.js) 的 `login` action 中完成 Turnstile、密码和 TOTP 校验，然后创建 D1 `admin_sessions` 并签发带 `sid` 的 JWT。
- 当前路由入口为 [`src/index.js`](../src/index.js)，管理 API 主要是 `POST /admin/api`；GitHub 会用浏览器 `GET` 回调，因此实现时需要独立的 start/callback GET 路由。
- [`src/middleware/auth.js`](../src/middleware/auth.js) 已要求 JWT 同时绑定活动 D1 Session；OAuth 最终应复用该 Session/JWT 链路，而不是引入第二套长期登录状态。
- 本研究启动前的已提交代码基线尚无 GitHub OAuth 登录实现；本文是实现约束，不代表功能已经部署、OAuth App 已创建或 Secret 已配置。

## 截至 2026-08-18 已核实的官方事实

### 1. Authorization Code Web Flow、state 与 PKCE

GitHub OAuth App 的 Web Flow 是三步：浏览器访问授权端点、GitHub 带临时 `code` 返回 callback、服务端用 access token 调用 API。GitHub 明确支持标准 authorization code grant；implicit grant 不受支持。[GitHub：Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#web-application-flow)

授权请求为：

```text
GET https://github.com/login/oauth/authorize
```

当前官方参数约束如下：[GitHub：Request a user's GitHub identity](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#1-request-a-users-github-identity)

| 参数 | 官方约束 |
| --- | --- |
| `client_id` | 必填。OAuth App 注册后获得。 |
| `redirect_uri` | 强烈建议。应指向应用 callback。 |
| `scope` | 依上下文而定；未授权过 scope 的用户默认空列表，但已有授权的用户在省略该参数时可能沿用这个 App 过去已授权的 scope。 |
| `state` | 强烈建议。必须是不可猜测的随机字符串，用于防 CSRF。 |
| `code_challenge` | 强烈建议。GitHub 当前明确支持 PKCE，要求 43 字符的 SHA-256 challenge。 |
| `code_challenge_method` | 与 challenge 配套，必须为 `S256`；不支持 `plain`。 |

GitHub 在成功授权后返回 `code` 和原 `state`。`code` 仅有效 10 分钟；若 callback 中的 `state` 不匹配，官方要求中止流程。[GitHub：Users are redirected back to your site](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#2-users-are-redirected-back-to-your-site-by-github)

截至本次核验，旧的“GitHub OAuth App 不支持 PKCE”结论已经过期。当前授权端点支持 `code_challenge` / `code_challenge_method=S256`，token 交换支持原始 `code_verifier`。PKCE 是对 authorization code 截获风险的额外保护，但不会替代本项目 Worker 端的 `client_secret`。

### 2. Token 交换

token 交换端点为：[GitHub：Exchange this code for an access token](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#2-users-are-redirected-back-to-your-site-by-github)

```text
POST https://github.com/login/oauth/access_token
```

`client_id`、`client_secret` 和 `code` 必填；`redirect_uri` 强烈建议，并用于与签发 code 时的 URI 对照；授权请求使用 PKCE 时，`code_verifier` 必填且必须是生成 challenge 的原值。设置 `Accept: application/json` 可获得 JSON 响应。不能只根据 HTTP 2xx 判定成功，还要拒绝 JSON 中的 `error`，例如 `incorrect_client_credentials`、`redirect_uri_mismatch` 或 `bad_verification_code`。[GitHub：Token request errors](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors)

GitHub 的 OAuth Web Flow 端点不支持浏览器 CORS preflight；再加上 token 交换必须提交 `client_secret`，交换动作必须在 Worker 服务端完成，不能从 Vue 前端直接 `fetch` token endpoint。[GitHub：Request a user's GitHub identity](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#1-request-a-users-github-identity)

GitHub 创建 OAuth App 时目前默认启用 expiring user access tokens。启用后 access token 有效 8 小时，refresh token 在 6 个月未使用后过期；token 响应会带 `expires_in`、`refresh_token` 与 `refresh_token_expires_in`。也可用 `offline_access` scope 为单次登录请求 expiring token。[GitHub：Expiring access tokens](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#expiring-access-tokens) [GitHub：Creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)

本项目无需代表管理员持续访问 GitHub API，因此没有请求 `offline_access` 或持久化/刷新 GitHub token 的必要。

### 3. Callback URL 的当前规则

截至 2026-08-18，OAuth App 注册页可配置最多 10 个 callback URL。[GitHub：Creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)

`redirect_uri` 可省略；省略时 GitHub 使用 App 配置的第一条 callback。当前每条 callback 可独立启用或关闭 wildcard matching：[GitHub：Redirect URLs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#redirect-urls)

- wildcard 关闭时，`redirect_uri` 必须与 callback URL 精确匹配。
- wildcard 开启时，去掉子域后的主机和端口必须匹配，路径必须等于 callback 路径或位于其子目录；这会放宽到任意子域和子目录。
- GitHub 明确警告 wildcard 可能把 authorization code 发送到攻击者控制的子域或路径，只有确实需要且控制所有可能子域/路径时才应启用。
- 2026-08-03 之前已有且只配置了一条 callback 的 App，为保持旧行为，该 callback 被保留为 wildcard 开启；官方建议不需要时关闭。

授权阶段和 token 交换阶段都应提交同一个固定 `redirect_uri`。GitHub 对不匹配的 URI 返回 `redirect_uri_mismatch`；用户拒绝授权时 callback 会收到 `error=access_denied`，并带回 `state`。[GitHub：Authorization request errors](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-authorization-request-errors)

### 4. `GET /user`、scope 与 email

GitHub OAuth token 可通过以下请求读取当前授权用户：[GitHub：Get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)

```text
Authorization: Bearer OAUTH-TOKEN
GET https://api.github.com/user
```

无 scope 已提供包括用户 profile 在内的公开信息只读访问；`GET /user` 只有在需要私有 profile 信息时才要求 `user` scope。[GitHub：Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) [GitHub：Get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)

GitHub 官方明确要求用用户不可变且不会复用于其他账户的数字 `id` 做持久身份键，不要使用会变化的 handle、组织 slug 或 email。[GitHub：Use the durable, unique id to store the user](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app#use-the-durable-unique-id-to-store-the-user)

`GET /user` 的 `email` 可能只是公开 email，也可能为 `null`。若产品真的需要读取账户的全部 email，必须请求 `user:email` 并调用 `GET /user/emails`；返回值含 `primary`、`verified` 和 `visibility`。[GitHub：List email addresses for the authenticated user](https://docs.github.com/en/rest/users/emails#list-email-addresses-for-the-authenticated-user)

因此，本项目的身份校验只需无 scope 的 `GET /user` 和数字 `id`。不请求 `read:user`、`user`、`user:email` 或 `repo`，不以 `login` 或 email 决定管理员身份。`login` 与 `avatar_url` 最多作为界面展示数据。

### 5. OAuth App 限制与安全建议

- GitHub 一般更推荐 GitHub App，因为它有细粒度权限、用户可控制仓库范围并使用短期 token；OAuth App 只能代表用户行动。当前 P1 只做登录、不访问仓库，选择 OAuth App 是范围受限的实现决定；未来若加入 GitHub 资源操作，应重新评估 GitHub App。[GitHub：Best practices for creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app#use-a-github-app-instead)
- 用户或组织最多拥有 100 个 OAuth App；单 App 当前最多 10 条 callback URL。[GitHub：Creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- GitHub 要求最小 scope；`client_secret` 和生成的 token 必须使用平台提供的安全存储。机密客户端应把 secret 放在 key vault、加密环境变量或服务端 secret 中。[GitHub：Secure your app's credentials](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app#secure-your-apps-credentials)
- 本项目是有浏览器和服务端 callback 的 Web 应用，不应启用 Device Flow。GitHub 明确认为 authorization code + PKCE 更合适，并提醒 Device Flow 没有 redirect URI 约束，可能被用于远程仿冒应用的钓鱼流程。[GitHub：Don't enable device flow without reason](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app#dont-enable-device-flow-without-reason)
- 每个 user/application/scope 组合最多保留 10 个 token，并限制每小时创建 10 个；同一用户一小时内第 11 次登录会触发重新授权提示。OAuth App 整体还有每小时 2,000 次 access-token 请求限制。实现不得在失败时循环重新发起授权或无界重试 token 交换。[GitHub：Creating multiple tokens](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#creating-multiple-tokens-for-oauth-apps) [GitHub：Rate limits for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/rate-limits-for-oauth-apps)
- GitHub 要求每次 REST API 请求有有效 `User-Agent`；无该 header 会被拒绝，无效值会得到 403。REST 请求推荐 `Accept: application/vnd.github+json`，并应显式发送 `X-GitHub-Api-Version`。截至核验时，官方支持 `2026-03-10`（尚未安排停止支持）和 `2022-11-28`（支持至 2028-03-10）；不带版本 header 会默认使用后者。本项目应固定当前版本 `2026-03-10`，避免无版本请求日后随默认值漂移。[GitHub：Getting started with the REST API](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#headers) [GitHub：API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)

### 6. Cloudflare Secrets 与 Workers Runtime

Cloudflare Workers Secret 是附加到 Worker 的加密文本 binding，适合 API key 和 auth token；在 Module Worker 中可通过 `fetch(request, env)` 的 `env` 读取。Cloudflare 明确禁止用 Wrangler 配置的明文 `vars` 保存敏感信息；本地 `.dev.vars` / `.env` 也不得提交 Git。[Cloudflare：Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

Secret 值定义后不会在 Wrangler 或 Dashboard 中再次可见，但 Worker 代码读取到的是原值。因此仍然不得记录、回显或写入审计。Cloudflare 还支持在 Wrangler 配置中声明 `secrets.required`，使 deploy/upload 在缺少必需 Secret 时失败。[Cloudflare：Secrets](https://developers.cloudflare.com/workers/configuration/secrets/#secrets-on-deployed-workers)

`npx wrangler secret put <KEY>` 会创建 Worker 新版本并立即部署。它不是本研究或普通本地测试步骤；配置真实 `GITHUB_OAUTH_CLIENT_SECRET` 必须另行取得上线授权，并通过交互式标准输入执行，不能放在命令参数、普通变量、日志或仓库中。[Cloudflare：Adding secrets via Wrangler](https://developers.cloudflare.com/workers/configuration/secrets/#via-wrangler)

Workers 的全局 `fetch()` 实现标准 Fetch API，但异步 I/O 必须发生在 request/scheduled 等 handler 的请求上下文内，不能在模块全局作用域发起。`fetch` 返回 `Promise<Response>`；对非 Cloudflare 源站使用 `cache: "no-store"` 可绕过 Cloudflare cache。[Cloudflare：Fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/)

Worker 主动创建的 `Request` 默认使用 `redirect: "follow"`。Cloudflare 明确警告：跟随重定向时，包括 `Authorization`、Cookie 和应用自定义敏感 header 在内的所有 header 都会被转发，即使目标已换成另一个域名；若这不是预期行为，应使用 `redirect: "manual"` 并自行执行重定向策略。本项目对 GitHub token endpoint 与 `/user` 应固定主机、使用 `redirect: "manual"`，并把任何 3xx 当作失败，防止 bearer token 或其他凭据被跨域转发。[Cloudflare：Request](https://developers.cloudflare.com/workers/runtime-apis/request/)

每次 OAuth callback 预期只有两次外部 subrequest（token 交换与 `GET /user`）。截至核验时 Workers Free 每次调用允许 50 次外部 subrequest；重定向链中的每一跳都会额外计数。固定两次顺序调用远低于限制，也进一步说明不应自动跟随重定向或无界重试。[Cloudflare：Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)

Workers Runtime 实现 Web Crypto API，`crypto.getRandomValues()` 提供密码学安全随机值，`crypto.subtle.digest('SHA-256', ...)` 可生成 PKCE challenge 所需摘要。[Cloudflare：Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)

Cloudflare 提醒：只变更 binding 时，旧 isolate 可能继续保留全局作用域中由旧 Secret 派生的对象。OAuth 代码应在每次请求中从 `env` 读取 `GITHUB_OAUTH_CLIENT_SECRET`，不能把持有 Secret 的客户端或派生对象永久缓存到模块全局。[Cloudflare：Making changes to bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/#making-changes-to-bindings)

## 本项目设计建议

以下是基于上述事实、当前 Session/TOTP 架构形成的项目建议，不是 GitHub 或 Cloudflare 对本仓库的直接要求。

### 1. 配置边界

| 配置 | 建议位置 | 理由 |
| --- | --- | --- |
| `GITHUB_OAUTH_CLIENT_ID` | 普通 Worker var | `client_id` 必然出现在浏览器授权 URL，不属于机密。 |
| `GITHUB_OAUTH_CLIENT_SECRET` | Cloudflare Worker Secret | token 交换必需，绝不回显、记录或提交。 |
| `GITHUB_OAUTH_CALLBACK_URL` | 普通 Worker var | 使用固定绝对 HTTPS URL；不要根据未经信任的 `Host`、`Origin` 或 query 动态拼接。 |
| 已绑定 GitHub numeric `id` | D1 管理员身份记录 | 需要通过现有已认证管理员流程绑定/解绑；不把身份键放进可随部署覆盖的前端配置。 |

一个环境优先使用一个独立 OAuth App，避免开发、测试和生产共享 client secret 或授权记录。若复用同一 App，最多只能配置 10 条 callback，且仍应逐条关闭 wildcard。

### 2. 固定路由与 callback

建议新增：

```text
POST /admin/api  action=github_oauth_start
GET /admin/oauth/github/callback
POST /admin/api  action=github_oauth_exchange
```

- callback 固定为例如 `https://<worker>/admin/oauth/github/callback`，在 App 设置、authorize 请求和 token 请求中使用完全一致的字符串，并关闭 wildcard。
- callback 只接受 `code`、`state` 或 GitHub 明确定义的 error 字段；拒绝额外控制 redirect 目标的任意 URL。
- 若前端与 Worker 同源，可由 callback 返回固定管理页；若使用 GitHub Pages/多 API 前端，callback 只签发短期、单次的内部 exchange ticket，再重定向到预先允许的前端 origin。JWT 不放入 query、fragment 或日志。
- 所有 callback、ticket exchange 和 JWT 响应设置 `Cache-Control: no-store`；callback 重定向同时设置 `Referrer-Policy: no-referrer`，避免 `code` / `state` 进入后续页面的 Referer。

### 3. state、PKCE 与一次性消费

每次 start：

1. 用 `crypto.getRandomValues()` 生成 32 字节随机 `state`，再以 base64url 无填充编码为 43 字符字符串。
2. 用 `HMAC-SHA-256(GITHUB_OAUTH_CLIENT_SECRET, "github-oauth-pkce:" + state)` 以域分离方式确定性派生 43 字符 PKCE verifier；对 verifier 做 SHA-256 后 base64url 编码得到 challenge，并发送 `code_challenge_method=S256`。
3. D1 只保存 `state` 的 SHA-256 摘要、固定 callback、流程类型（login/bind）、创建/过期时间和消费状态，不保存或加密 verifier。callback 在原子消费原始 `state` 后用同一 HMAC 规则重新派生 verifier。`GITHUB_OAUTH_CLIENT_SECRET` 轮换会使尚未完成的流程失效，这是可接受的安全取舍。
4. TTL 不超过 GitHub code 的 10 分钟；建议本项目取 5 分钟。

callback 必须先校验 state 格式，再以摘要查询并用条件更新原子标记为已消费。过期、未知、重复使用或流程类型不符均失败关闭。即使 GitHub 返回 `access_denied`，也应先验证并消费对应 state，防止错误回调被伪造或重放。

### 4. 账户绑定而非“首个登录者获胜”

- 首次绑定只能由已有密码 Session 发起；若已启用 TOTP，还必须完成当前本地 TOTP/恢复码挑战。
- callback 用无 scope token 调 `GET /user`，把 numeric `id` 保存为唯一 provider identity；`login` 和 avatar 仅作展示。
- 未绑定时，任何匿名 GitHub callback 都不得自动成为管理员。
- 解绑和替换绑定同样要求有效 Session 与本地第二因素，并写不含 token/code/state 的审计事件。
- 密码登录始终保留；绑定、解绑或 GitHub 故障不能删除密码凭据或撤销所有密码 Session。

### 5. OAuth 登录仍受本地 TOTP 保护

GitHub 身份匹配后：

- TOTP 未启用：可创建 `auth_method=github_oauth` 的 `admin_sessions`，再复用现有 JWT 签发逻辑。
- TOTP 已启用：callback 不直接签发 JWT，只生成短期、单次、服务端存储摘要的 internal login ticket；前端用该 ticket 加 TOTP 或恢复码完成第二步，成功后创建 `auth_method=github_oauth_totp` 或 `github_oauth_recovery` Session。
- GitHub OAuth 失败与本地 TOTP 失败使用独立的失败预算；现有已登录 TOTP 操作限流不能被 OAuth 路径绕过。

这可避免“开启本地 TOTP 后，改点 GitHub 登录就绕过第二因素”的降级。

### 6. GitHub token 的最小生命周期

callback 中按以下顺序处理：

1. 原子消费 state，并用原始 state 与 `GITHUB_OAUTH_CLIENT_SECRET` 重新派生 verifier。
2. 用固定 callback、`client_secret` 和 verifier 交换 token；请求 `Accept: application/json`、`cache: "no-store"`、`redirect: "manual"`，不跟随 3xx，也不对业务错误自动重试。
3. 用 token 请求 `GET https://api.github.com/user`，headers 至少包含 `Authorization: Bearer ...`、有效 `User-Agent`、`Accept: application/vnd.github+json` 和 `X-GitHub-Api-Version: 2026-03-10`；同样使用 `cache: "no-store"`、`redirect: "manual"` 并拒绝 3xx。
4. 校验返回 JSON 的 numeric `id` 与已绑定 ID 完全相等。
5. 创建本地 login ticket 或 Session 后立即丢弃 GitHub token 引用。

不要把 GitHub access token、refresh token、authorization code、PKCE verifier、原始 state 或 client secret 写进 D1 长期表、Session、JWT、响应、URL、日志或审计。因为不保存 token，也不需要 `offline_access`、refresh 逻辑或后台 GitHub API 调用。

### 7. 失败语义与测试重点

- 缺少 client ID/secret/callback 时，GitHub 登录入口显示“未配置”，不得回退到硬编码默认值。
- state 不匹配、过期、重放，code 过期，token endpoint 非 2xx/JSON error，`GET /user` 非 200、非 JSON、缺少 numeric `id`，以及 ID 不匹配都不得创建本地 Session。
- token endpoint 与 `/user` 使用有限超时；网络错误返回可重试的通用消息，但不向浏览器暴露 GitHub 原始 token、Secret 或内部响应体。
- `scope` 预期为空；若 token 响应出现非空 scope，应失败关闭并提示检查 OAuth App 是否曾被用于更宽授权。该 App 应专用于登录，永远不请求仓库或 email scope。
- 并发 callback 只能有一个请求消费 state；并发 exchange ticket 只能有一个请求创建 Session。
- 登录成功、身份不匹配、state 校验失败、绑定和解绑都写结构化审计；OAuth 审计 detail 只包含固定的 provider、reason、method，不含 numeric ID 或任何 OAuth 凭据。
- 前端的迟到 callback/exchange 响应必须遵循现有多站点请求隔离，不能覆盖当前站点的新 JWT。

## 实施前检查清单

- [ ] OAuth App 使用固定 HTTPS callback，关闭 wildcard；若 App 创建于 2026-08-03 前，主动核对现有 wildcard 状态。
- [x] 只请求空 scope，并以 numeric `id` 做唯一身份键。
- [x] authorize 和 token 请求都带完全相同的固定 `redirect_uri`。
- [x] state、S256 PKCE、短期 TTL、原子单次消费均有测试。
- [x] TOTP 已启用时 OAuth 不能直接签发 JWT。
- [x] GitHub token 只在 callback 内存中使用，不落库、不进日志、不进入本地 JWT。
- [x] `GITHUB_OAUTH_CLIENT_SECRET` 只作为 Cloudflare Secret，通过 `env` 按请求读取。
- [x] 密码应急登录、现有 Session 撤销/刷新和多站点 Token 隔离保持不变。
- [x] 本地全测、前端构建、Wrangler dry-run 和 Secret 模式扫描通过后才提交；创建 App、写入真实 Secret 和部署仍需单独授权。

## 官方来源

### GitHub Docs

- [Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [Creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [Best practices for creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app)
- [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [Troubleshooting authorization request errors](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-authorization-request-errors)
- [Troubleshooting OAuth app access token request errors](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors)
- [Rate limits for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/rate-limits-for-oauth-apps)
- [Get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)
- [List email addresses for the authenticated user](https://docs.github.com/en/rest/users/emails#list-email-addresses-for-the-authenticated-user)
- [Getting started with the REST API](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api)
- [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)

### Cloudflare Developers

- [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Workers Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
