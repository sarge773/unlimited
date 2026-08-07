# Contributing to freellmapi

Contributors are very welcome. This project is a local-first aggregator for free LLM API tiers, so most contributions fall into a few buckets: adding a provider, adding an endpoint, improving the router, polishing the dashboard, or fixing bugs. The README has a "Good first PRs" list if you want a starting point.

AI agents contributing to this repo should read [`AGENTS.md`](AGENTS.md) first — it carries the always-on constraints (validation gates, commit style, security red lines).

## Development loop

```bash
npm install
npm run dev             # server on :3001, dashboard on :5173, both with HMR
npm run db:migration:up # apply all the migrations to your local database
npm test                # server vitest; also runs client tests if present
npm run build           # compile server and dashboard
```

Every PR should:

- Include a test, and keep the existing suite green (`npm test`).
- Match the `.editorconfig` and tsconfig defaults already in the repo.
- Stay scoped to one change. Smaller PRs get reviewed and merged faster.
- Avoid adding paid or card-gated services. This catalog only lists tiers that are genuinely free to start using without a credit card.

## Code style

- **TypeScript 严格模式**；类型从 zod schema 用 `z.infer` 推导（如 `SearchConfig`），不重复手写接口
- **命名**：camelCase 变量/函数、PascalCase 组件/类型、`_` 前缀私有
- **i18n**：文案走 `t('key')`，不硬编码字符串；新增 key 同步 60 locales
- **样式**：Tailwind 原子类 + 语义 CSS 变量（`--muted-foreground` 等），不硬编码 hex
- **时间**：SQLite 存 UTC（空格格式）；前端展示用 `formatSqliteUtcToLocalTime` 转本地时区
- 不重构无关代码；改动聚焦单一主题

## Validation (required before commit)

```bash
cd server && npx tsc --noEmit     # server 类型
cd client && npx tsc -b           # client 类型
npm run check:i18n                # 60 locales / key parity（client 目录）
```

- 新功能补测试（vitest：`server/src/__tests__`、`client/src/__tests__`）
- **catalog / 模型改动**：必须实测可用（`POST /v1/chat/completions` 返回 200，免费账号），在注释/PR 注明验证日期与方式
- CI 会跑 fmt / tsc / tests / i18n —— 本地先过一遍再提交

## Database migrations

Schema changes must use file-per-migration files under
`server/src/db/migrations/`. Do not edit previously applied migration files.

Control database migrations with ([db/README.md](server/src/db/README.md)):

```bash
npm run db:migration:create --name=add_embedding_index
npm run db:migration:up
npm run db:migration:down
```

## Catalog conventions

- 模型添加：`server/src/db/model-pricing.ts`（pricing）+ migrations 的 `additions` 数组
- `model_id` 用 `/v1/models` 返回的精确 id（name:tag，如 `gpt-oss:20b`）
- **只加真免费模型**；免费变付费的必须人工确认移除（#722 教训）
- pricing 镜像同模型 paid 变体；无参考时用合理默认并注释说明
- 可用性证明写进代码注释：验证日期 + 方式（如 "tested 2026-08-06 against Free tier"）

## Commits

- Conventional Commits：`feat:` / `fix:` / `docs:` / `test:` / `style:` / `refactor:`
- 正文说明"为什么"；关联 issue `Refs #xxx`
- 结尾加 `Co-Authored-By` trailer（AI 贡献者）
- 一个 PR 一个主题；不要混合无关改动

## Pull requests

PR 描述用模板：

```markdown
## What
（改了什么，面向维护者）

## Why
（为什么值得合入，关联 issue `Refs #xxx`）

## Tests
（验证证据：tsc 结果、测试数量、实测记录）

## Files
（关键文件列表）
```

- 测试证据如实说明；无法本地验证（如无工具链）必须标注"依赖 CI 验证"
- **不做半成品**：不提交"存了但没用"的代码（#590 教训）
- 网络策略：github 直连失败时用 VPS 代理重试（`-x http://llmproxy:...@43.133.45.67:7890`）

## Translations

The dashboard ships 60 locales. `en.json` is the source of truth and every other file mirrors
its keys, so run `npm run check:i18n` from `client/` before opening a PR. See
[docs/translating.md](docs/translating.md) for the full rules and the settled Chinese
terminology.

## AI and LLM-assisted contributions

LLM-assisted PRs are welcome. A lot of this codebase is itself built that way, so there is no stigma here. The bar is the same as for any other PR: you are responsible for what you submit.

That means:

- **Understand your own diff.** If a reviewer asks why a line is there, you should be able to answer. Do not open a PR you cannot explain.
- **Test it for real.** Run the code, not just the prompt. Generated tests that do not actually exercise the change, or that pass against a mock of the wrong shape, are worse than no tests.
- **Keep it scoped.** Tools love to "helpfully" reformat unrelated files, rename things, or rewrite comments. Strip that out before opening the PR so the diff is only the change you intend.
- **No invented facts.** Provider rate limits, model ids, and endpoints must be verified against the provider, not recalled by a model. A wrong rate limit in the catalog is a bug that ships to everyone.
- **Disclose nothing special required.** You do not need to label a PR as AI-assisted. We care about the result, not the keystrokes.

PRs that are clearly unreviewed model output (broad unexplained diffs, fabricated limits, tests that do not run) will be asked for changes or closed.

## Security

- API key 回显一律 `maskKey`；日志/PR/评论不出现明文
- 敏感文件 0o600；SSRF 检查（`url-guard`）；代理/凭据脱敏（`redactProxyUrl`）
- 认证统一 API key（`timingSafeStringEqual`），不信任 socket 本地性
- 涉及敏感数据的功能：先讨论权限/脱敏方案再实现

## Reporting issues

Bug reports are most useful with: your version (or commit), the provider involved, and the exact request and response where you can share them. For verification or routing bugs, the server logs around the failing request help a lot.

## Related community work

Some useful fixes and experiments live in community forks and branches. If you are looking for prior art before starting, these are worth a read:

- `fix-loopback-only` — restrict admin API access to localhost to avoid external exposure.
- `fix-35-admin-security` — optional `ADMIN_PASSWORD` HMAC auth for remote admin API access.
- `fix-101-markdown` — Markdown rendering in the Playground UI.
- `fix-119-atomic-ratelimits` — atomic SQLite `BEGIN IMMEDIATE` transactions to fix rate-limit race conditions.
- `feature-122-auto-routing` — per-request `smart` / `fast` / `cheap` routing strategies.

If you port one of these into a PR, credit the original author in the PR description so they land in the Contributors list.
