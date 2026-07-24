# GitHub Actions 生产部署

本文是 `2198923/cloud-mail` 的生产部署说明，基于上游 `maillab/cloud-mail` 的 GitHub Actions 教程，并针对当前实例补齐了 Secret 隔离、单测门、单一发布器和 Email Routing 生命周期管理。

## 当前生产资源

- Worker：`cloud-mail-grok`
- API 自定义域：`mailapi.web3wy.com`
- 邮件子域：`grokmail.web3wy.com`
- D1：`cloud-mail-grok`
- KV：`cloud-mail-grok-kv`
- 自动发布器：GitHub Actions `.github/workflows/deploy-cloudflare.yml`
- R2：当前 Cloudflare 账户尚未启用；应用按上游实现自动回退到 KV 存储附件

> 同一个 Worker 只能保留一个 push 自动发布器。当前已停用 Cloudflare Workers Builds 的 Git trigger，禁止再次同时启用它和 GitHub Actions push 部署。

## Repository Secrets

进入仓库：`Settings → Secrets and variables → Actions → Repository secrets`。

| Secret | 必需 | 用途 |
| --- | :---: | --- |
| `NAME` | 是 | Worker 名称，当前为 `cloud-mail-grok` |
| `CUSTOM_DOMAIN` | 是 | API 自定义域 |
| `DOMAIN` | 是 | JSON 数组格式的邮件域，例如 `["grokmail.web3wy.com"]` |
| `ADMIN` | 是 | 管理员邮箱，仅作为 Secret 保存 |
| `JWT_SECRET` | 是 | 至少 32 字符；仅写入 Worker Secret |
| `CLOUDFLARE_API_TOKEN` | 是 | GitHub Actions 专用最小权限部署 Token |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | Cloudflare Account ID |
| `D1_DATABASE_ID` | 是 | 已有 D1 数据库 ID |
| `KV_NAMESPACE_ID` | 是 | 已有 KV Namespace ID |
| `CF_EMAIL_ROUTING_TOKEN` | 是 | 仅限目标 Zone 的 Email Routing Rules Write Token；仅写入 Worker Secret |
| `R2_BUCKET_NAME` | 否 | 仅在账户已启用 R2 且 Bucket 已创建时填写 |
| `PROJECT_LINK` | 否 | 项目链接 |
| `CF_EMAIL` | 否 | 是否绑定 Cloudflare Send Email |
| `ANALYSIS_CACHE` | 否 | AI 分析缓存开关 |
| `LINUXDO_CLIENT_ID` | 否 | LinuxDo OAuth Client ID |
| `LINUXDO_CLIENT_SECRET` | 否 | LinuxDo OAuth Secret；只写入 Worker Secret |
| `LINUXDO_CALLBACK_URL` | 否 | LinuxDo OAuth 回调地址 |
| `LINUXDO_SWITCH` | 否 | LinuxDo OAuth 开关 |

不要把 Token、JWT 或 OAuth Secret 写入 Git、Wrangler `[vars]`、Actions Variables、命令行参数、初始化 URL 或日志。

## Cloudflare Token 权限

### GitHub Actions 部署 Token

该 Token 仅用于 Wrangler 部署，当前已通过真实上传验证。权限范围：

- Account：
  - Workers Scripts Write
  - D1 Read
  - Workers KV Storage Read
  - Workers AI Read
- 目标 Zone：
  - Workers Routes Write
  - Zone Read

它不应拥有 Email Routing、DNS、API Token 管理或 Account Settings Write 权限。

### Email Routing 运行时 Token

`CF_EMAIL_ROUTING_TOKEN` 与部署 Token 分离，只授予真实根 Zone 的 Email Routing Rules Write。Worker 使用它为每个活跃邮箱同步一条精确规则：

```json
{
  "enabled": true,
  "matchers": [
    {"type": "literal", "field": "to", "value": "user@grokmail.web3wy.com"}
  ],
  "actions": [
    {"type": "worker", "value": ["cloud-mail-grok"]}
  ]
}
```

父 Zone 内的邮件子域没有独立 Catch-all，禁止在 Wrangler 中配置 `*@grokmail.web3wy.com`，也禁止应用修改根域 Catch-all。

## 根域邮件策略

根域 Catch-all 固定对象不能按普通规则删除。当前配置为：

- `enabled = false`
- action = `drop`
- forward destination = 0

原 Gmail Destination Address 已从 Cloudflare 账户删除。子域的 exact Worker 规则与根域 Catch-all 相互独立。

## 工作流行为

`deploy-cloudflare.yml` 在 `main` 的 Worker、前端、工作流或 Wrangler 配置变化时自动运行，也支持手动 `workflow_dispatch`。

发布顺序：

1. Checkout、安装固定版本 pnpm/Node；
2. 在任何部署凭据注入前，执行全部路由生命周期单测并构建 Vue 静态资源；
3. 校验必需配置，生成不含 `[build]` 的 Actions 临时 Wrangler 配置；
4. 仅在上传步骤注入最小权限部署 Token，部署 Worker、D1/KV/AI/Assets、自定义域和 Cron；
5. 通过 stdin 批量写入 JWT、Email Routing Token 和可选 OAuth Secret；
6. 请求生产 `websiteConfig` API，业务 `code=200` 才算成功。

工作流使用并发组，避免两个生产部署同时覆盖；所有第三方 Actions 都固定到提交 SHA。

## 初始化说明

当前生产 D1 已完成初始化，不需要在每次部署后重复执行初始化。

禁止把 JWT 放入 `/api/init/{jwt}` 并由 CI 请求：URL 可能进入代理、浏览器、平台和 Actions 日志。若未来创建全新实例，应在受控环境中完成一次性初始化，完成后立即轮换 JWT，并确认数据库迁移和管理员登录成功。

## 验收清单

每次发布后必须分别验证：

1. GitHub Actions 运行成功；
2. 最新 Cloudflare deployment 为 100% 流量；
3. `db`、`kv`、`ai`、`assets`、`jwt_secret`、`CF_EMAIL_ROUTING_TOKEN` 绑定仍存在；
4. `https://mailapi.web3wy.com/api/setting/websiteConfig` 返回 HTTP 200 且业务 `code=200`；
5. D1 活跃邮箱集合与 exact Worker 规则集合一致；
6. 随机邮箱创建 → 软删 → 恢复 → 物理删除闭环无残留；
7. 根域 Catch-all 仍为 disabled/drop，Destination Address 为 0；
8. 临时 Token、脚本和凭据明文副本已删除。
