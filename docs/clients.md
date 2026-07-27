# Clients & coding agents

[← Back to README](../README.md) · [Documentation index](README.md)

- [OpenAI-compatible clients](#openai-compatible-clients)
- [Coding agents](#coding-agents)
- [MCP server](#mcp-server)
- [VS Code ghost-text autocomplete (Continue)](#vs-code-ghost-text-autocomplete-continue)
- [Context Handoff](#context-handoff)

## OpenAI-compatible clients

Any client that can target an OpenAI-compatible base URL can use FreeLLMAPI:

- **LangChain, LlamaIndex, official OpenAI SDKs**: set `base_url` to
  `http://localhost:3001/v1` and use the unified key from the dashboard.
- **Local GPU boxes**: add custom OpenAI-compatible endpoints for Ollama,
  llama.cpp, LM Studio, vLLM, or an internal gateway.

## Coding agents

Every recipe below is the same three facts in a different config file: base URL
`http://localhost:3001/v1`, the unified key from the dashboard's Keys page, and
a model (`auto` lets the router pick).

| Agent | Setup |
| --- | --- |
| **Claude Code** | `ANTHROPIC_BASE_URL=http://localhost:3001` + `ANTHROPIC_AUTH_TOKEN=<unified key>` — full walkthrough in [Anthropic / Claude clients](api.md#anthropic--claude-clients) |
| **Codex CLI** | add a provider in `~/.codex/config.toml` with `base_url = "http://localhost:3001/v1"` and its `env_key` pointing at the unified key — the `/v1/responses` surface it needs is implemented |
| **Cline / Roo Code** | provider type "OpenAI Compatible", base URL `http://localhost:3001/v1`, unified key, model `auto` (or any id from `/v1/models`) |
| **Continue** | `apiBase: http://localhost:3001/v1` in its config; inline autocomplete works too via the legacy `/v1/completions` surface |
| **Aider** | `OPENAI_API_BASE=http://localhost:3001/v1` + `OPENAI_API_KEY=<unified key>`, then `aider --model openai/auto` |
| **opencode** | OpenAI-compatible provider with the same base URL and key |
| **Cursor** | paste the unified key under a custom OpenAI base URL — but note Cursor verifies and calls the API **from its servers**, so your router must be reachable from the internet (a tunnel or a host with a public address), not just `localhost` |

## MCP server

On top of inference, the router is an **MCP server**: agents can introspect it mid-session
(usable models and the params each one honors, provider health, usage and cache stats,
routing strategy). For Claude Code:

```bash
claude mcp add --transport http freellmapi http://localhost:3001/mcp \
  --header "Authorization: Bearer freellmapi-your-unified-key"
```

Any MCP client that speaks Streamable HTTP works the same way: point it at `/mcp` with the
unified key as a Bearer token.

FreeLLMAPI is local-first and single-user by design. Your provider keys stay in
your SQLite database, encrypted at rest, and requests go from your machine to the
upstream providers you enabled.

## VS Code ghost-text autocomplete (Continue)

FreeLLMAPI exposes `/v1/completions` for editor autocomplete clients that send legacy OpenAI prompt/suffix requests. Example Continue config:

```yaml
models:
  - name: FreeLLMAPI Autocomplete
    provider: openai
    model: auto
    apiBase: http://localhost:3001/v1
    apiKey: freellmapi-your-unified-key
    useLegacyCompletionsEndpoint: true
    roles:
      - autocomplete
```

## Context Handoff

When FreeLLMAPI falls over to a different model mid-conversation (quota, rate limit, cooldown), the new model has no idea it is picking up someone else's task. **Context handoff** adds a single compact `system` message to the outbound request that tells the new model exactly that:

```
FreeLLMAPI context handoff:
You are taking over an ongoing conversation from another model (groq:llama-3 → google:gemini-flash).
Continue the user's task using the conversation context already provided in this request.
Do not restart the task, re-ask already answered setup questions, or discard prior tool results.
Respect the user's latest message as the highest-priority instruction.

Recent session summary:
User: …
Assistant: …
```

**Enable it in `.env`:**

```env
FREELLMAPI_CONTEXT_HANDOFF=on_model_switch
```

**How it works:**

- Messages per session are stored in memory (TTL: 3 hours).
- Only injected when the selected model changes for a given session key.
- Not injected on the first request, on same-model continuations, or if a handoff message is already present.
- Session key: `X-Session-Id` header if present, otherwise SHA-1 of the first user message (same as sticky sessions).
- Storage is in-memory only. Nothing is written to disk or logged.

> **Important:** Context Handoff improves continuity for conversations routed through FreeLLMAPI. It cannot recover provider-internal hidden state or messages that were never sent to the proxy.
