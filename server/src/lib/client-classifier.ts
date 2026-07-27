import type { Request } from 'express';

export const CLIENT_AGENTS = [
  'claude-code',
  'codex',
  'cline',
  'roo',
  'continue',
  'aider',
  'opencode',
  'goose',
  'qwen-code',
  'kilo-code',
  'crush',
  'cursor',
  'gemini-cli',
  'zed',
  'jetbrains',
  'ollama-client',
  'openai-sdk',
  'anthropic-sdk',
  'unknown',
] as const;

export type ClientAgent = (typeof CLIENT_AGENTS)[number];

function header(req: Request, name: string): string {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase() ?? '';
}

/**
 * Best-effort classifier from stable protocol/header signals first, then UA.
 * It intentionally returns a coarse enum: analytics should remain useful when
 * a client revs its version string or wraps an underlying SDK.
 */
export function classifyClientAgent(req: Request): ClientAgent {
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0].toLowerCase();
  const ua = header(req, 'user-agent');

  if (header(req, 'x-claude-code-session-id') || /claude[- ]?code/.test(ua)) return 'claude-code';
  if (path.startsWith('/v1/responses') || /\bcodex\b/.test(ua)) return 'codex';
  if (path.startsWith('/v1beta/') || /gemini[- /]?cli/.test(ua)) return 'gemini-cli';
  if (/qwen[- ]?code|\bqwen-cli\b/.test(ua)) return 'qwen-code';
  if (/kilo[- ]?code|\bkilocode\b/.test(ua)) return 'kilo-code';
  if (/\bcrush(?:\/|\s|$)/.test(ua)) return 'crush';
  if (/opencode/.test(ua)) return 'opencode';
  if (/\bcline\b/.test(ua)) return 'cline';
  if (/\broo[- /]/.test(ua) || /roo code/.test(ua)) return 'roo';
  if (/continue(?:\.dev)?/.test(ua)) return 'continue';
  if (/\baider\b/.test(ua)) return 'aider';
  if (/\bgoose\b/.test(ua)) return 'goose';
  if (/\bcursor\b/.test(ua)) return 'cursor';
  if (/\bzed\b/.test(ua)) return 'zed';
  if (/jetbrains|intellij|pycharm|webstorm/.test(ua)) return 'jetbrains';
  if (path.startsWith('/api/chat')
      || path.startsWith('/api/generate')
      || path.startsWith('/api/tags')
      || /\bollama\b/.test(ua)) return 'ollama-client';
  if (/anthropic|claude-sdk/.test(ua)) return 'anthropic-sdk';
  if (/openai|langchain|litellm/.test(ua)) return 'openai-sdk';
  return 'unknown';
}
