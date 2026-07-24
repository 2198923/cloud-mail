# Cloud Mail 生产维护说明

本仓库的生产实例是 `cloud-mail-grok`。涉及 Cloudflare Worker、D1、KV、Assets、AI、Custom Domain 或 Email Routing 的修改，必须遵守本文。

## 生产入口与部署

- 生产 API：`https://mailapi.web3wy.com`
- Worker：`cloud-mail-grok`
- 邮件域：`grokmail.web3wy.com`
- canonical 配置：仓库根目录 `wrangler.toml`
- 兼容子目录构建：`mail-worker/wrangler.toml`
- 根目录 `wrangler.toml`、子目录 `mail-worker/wrangler.toml` 和 GitHub Actions 使用的 `mail-worker/wrangler-action.toml`，其 Worker 绑定与 Email Routing 非敏感变量必须保持一致；三者都必须启用 `keep_vars = true`，避免覆盖 Dashboard 变量和既有 Secret。
- Token 只允许存为 Worker Secret，禁止写入 Git、Wrangler `[vars]`、日志或测试 fixture。
- `jwt_secret` 同样只能是 Worker Secret；GitHub Actions 必须通过 stdin 执行 `wrangler secret put`，禁止把 `${JWT_SECRET}` 渲染进 TOML。
- 生产 push 的唯一自动发布器是 GitHub Actions `deploy-cloudflare.yml`；Cloudflare Workers Builds 的 Git trigger 必须保持删除状态，禁止两个发布器同时部署。
- 三份 Wrangler `[build]` 都必须先执行 `mail-worker` 的 `test:unit`，测试不通过时禁止上传 Worker；GitHub Actions 还必须在注入部署 Token 前显式完成单测和前端构建，并从临时发布配置移除 `[build]`，禁止构建进程继承部署凭据。

常用命令：

```bash
# Worker 单元测试
cd mail-worker
npx vitest run --config vitest.unit.config.js

# Worker 路由生命周期单元测试
npm run test:unit

# 根配置构建/部署前验证
cd ..
npx wrangler deploy --dry-run

# 生产部署
npx wrangler deploy
```

每次部署后必须回读最新 deployment 和 settings，确认至少仍有 `db`、`kv`、`assets`、`ai` 及 Email Routing Secret，并调用真实依赖 D1 的业务 API；只看到 HTTP 200 不算验收。

## Email Routing 架构（重要）

Cloudflare 当前不支持在父 Zone 内为 `grokmail.web3wy.com` 单独建立 Catch-all。官方控制台明确说明 Catch-all 只作用于 Zone 级域名；Email Routing 子域返回的 ID 只是 DNS 设置对象 ID，不是独立 Zone ID。

因此：

- **禁止应用代码调用或修改** `/email/routing/rules/catch_all` 来实现子域收件；根域转发不属于本应用的生命周期。
- **禁止**在 Wrangler 中加入 `addresses = ["*@grokmail.web3wy.com"]`；planner 无法为父 Zone 子域创建独立 Catch-all。
- 每个活跃邮箱必须有一条精确规则：

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

- 规则写入根 Zone 的 `/zones/{zone_id}/email/routing/rules`。
- 列表 API 单页最多 50 条；冲突检查必须遍历 `result_info.total_pages`，不能只读第一页。免费方案精确规则容量约 200 条，达到上限时必须 fail closed，不得悄悄跳过同步。
- 只有“唯一精确 matcher + 唯一预期 Worker action”的规则可以幂等复用或删除；存在其他 action、多条匹配、禁用规则或异常响应时必须停止，不能自动接管。
- API 错误必须对用户返回通用错误，不能把 Token、Cloudflare 原始错误、目标转发地址或完整响应写入日志/响应。

Worker 运行时配置：

- Secret：`CF_EMAIL_ROUTING_TOKEN`
- 非敏感变量：
  - `CF_EMAIL_ROUTING_ZONE_ID`
  - `CF_EMAIL_ROUTING_DOMAIN`
  - `CF_EMAIL_ROUTING_WORKER`
  - `CF_EMAIL_ROUTING_RULE_LIMIT`

Token 权限应仅限目标真实根 Zone 的 Email Routing Rules Write。上线前至少做一次随机精确规则 `POST -> GET -> DELETE` 探针；应用和验收脚本不得修改 Catch-all。

## 邮箱生命周期不变量

- 创建邮箱：先确保精确路由成功，再写 D1；路由失败时不得返回创建成功。
- 创建后的 D1 操作失败：只回滚本次新建的规则，不能删除原本已存在的正确规则。
- 删除邮箱：先确认并删除预期精确规则，再软删/物理删除 D1 记录；Cloudflare 失败时保留邮箱记录，避免 UI 显示删除成功但控制面残留。
- 恢复邮箱：先恢复精确路由，再把 D1 记录恢复为活跃。
- 批量物理删除用户：先收集其全部邮箱并完成对应规则清理；任一冲突或 API 失败都应终止数据库删除。
- 所有邮箱地址比较统一小写；只能操作 `CF_EMAIL_ROUTING_DOMAIN` 下的地址。

## 生产验收清单

1. D1 中每个活跃用户的 `is_del=0` 邮箱恰好有一条启用的 exact literal-to Worker 规则。
2. 创建一个随机临时别名：业务 API 成功，路由 API 回读到唯一规则。
3. 删除该别名：业务 API 成功，D1 标记删除，路由 API 中规则消失。
4. 从真实外部邮件源投递到活跃邮箱，并同时通过 `/email/latest` 与 `/email/list` 读到同一封邮件；不能只验证 MX/DNS 或 HTTP 健康检查。
5. 删除所有临时邮箱、规则、目标地址、OAuth 中继、诊断正文和本地凭据文件。

## 安全红线

- 不在命令行参数、Git、聊天、截图或日志中传递 Token、Global API Key、JWT、管理员密码、OAuth code/state。
- 高权限 Global API Key 只允许通过 `0600 root:root` 临时文件短时使用；任务完成后删除并轮换。
- `CF_EMAIL_ROUTING_TOKEN` 是生产运行凭据：部署为 Worker Secret 后删除本地明文副本；如需替换，先创建/验证新 Token，再更新 Secret，最后撤销旧 Token。
- 任何真实收件验收产生的正文、验证链接或目标地址状态文件都属于敏感诊断材料，验收后删除。
