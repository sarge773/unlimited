# AGENTS.md — freellmapi 开发约束（AI 常驻内核）

> 本文件是提交给 AI 编码代理的常驻上下文。`CLAUDE.md` 是指向本文件的链接。
> 每一行都过检验："去掉会导致 agent 犯错吗？"详细规则见 `CONTRIBUTING.md`。
> 约束与当前代码冲突时，以当前代码为准，先说明差异再改文档或实现。

## 项目速览

- **freellmapi**：免费 LLM API 网关/代理（OpenAI / Anthropic 兼容）
- **技术栈**：Node + Express + better-sqlite3（`server/`）、React + Vite + Tailwind（`client/`）
- **关键数据**：models（catalog + 路由分数）、api_keys（凭据）、requests（用量/延迟/TTFB）、attempt-trace（重试链）

## 代码约定（项目特有）

- **i18n**：所有用户可见文案走 `t('key')`，不硬编码字符串；新增 key 必须同步所有 locale（`check:i18n` 60 locales）
- **样式**：Tailwind 原子类 + 语义 CSS 变量（`--muted-foreground` 等），不硬编码 hex
- **类型**：用 `z.infer` 从 zod schema 推类型（如 `SearchConfig`），不重复手写接口
- **时间**：SQLite 存 UTC（空格格式 `YYYY-MM-DD HH:MM:SS`）；前端展示用 `formatSqliteUtcToLocalTime` 转本地时区

## 验证流程（提交前必须）

- server：`cd server && npx tsc --noEmit` 通过
- client：`cd client && npx tsc -b` 通过
- i18n 完整性：`npm run check:i18n` 通过
- 新功能补测试；**catalog/模型改动必须实测可用**（返回 200 + 免费账号验证，注明验证日期/方式）

## 提交规范

- Conventional Commits（`feat:` / `fix:` / `docs:` / `test:` / `style:` / `refactor:`）
- 正文说明"为什么"，不罗列"改了什么"；关联 issue 用 `Refs #xxx`
- 一个 PR 一个主题，分功能提交（维护者易合并）

## 安全红线（do 优先）

- API key 回显一律 `maskKey`，日志/PR/评论不出现明文
- 敏感文件 0o600、SSRF 检查（`url-guard`）、代理/凭据脱敏（`redactProxyUrl`）
- 认证统一 API key（`timingSafeStringEqual`），不信任 socket 本地性

## 关键约束

- **不做半成品**：不提交"存了但没用"的代码/字段（#590 教训）
- **只加真免费模型**；免费变付费的必须人工确认移除（#722 教训）
- 模型 `model_id` 用 `/v1/models` 返回的精确 id（name:tag 约定）
- 网络策略：github 直连失败时走 VPS 代理重试

## 详细参考

- `CONTRIBUTING.md` — 完整开发流程（环境/风格/验证/catalog/PR）
- 架构与协议细节见 `docs/`（`api.md`、`architecture.md`）
