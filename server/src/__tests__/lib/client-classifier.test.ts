import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { classifyClientAgent } from '../../lib/client-classifier.js';

function request(path: string, headers: Record<string, string> = {}): Request {
  return {
    originalUrl: path,
    headers,
  } as unknown as Request;
}

describe('client agent classification', () => {
  it('prefers distinctive headers and protocol paths', () => {
    expect(classifyClientAgent(request('/v1/messages', {
      'x-claude-code-session-id': 'session',
    }))).toBe('claude-code');
    expect(classifyClientAgent(request('/v1/responses'))).toBe('codex');
    expect(classifyClientAgent(request('/v1beta/models/x:generateContent'))).toBe('gemini-cli');
    expect(classifyClientAgent(request('/api/chat'))).toBe('ollama-client');
    expect(classifyClientAgent(request('/v1/t/revocable/responses'))).toBe('codex');
    expect(classifyClientAgent(request('/v1/t/revocable/api/chat'))).toBe('ollama-client');
  });

  it('recognizes common coding-agent user agents', () => {
    expect(classifyClientAgent(request('/v1/chat/completions', {
      'user-agent': 'opencode/1.2.3',
    }))).toBe('opencode');
    expect(classifyClientAgent(request('/v1/chat/completions', {
      'user-agent': 'aider/0.80',
    }))).toBe('aider');
    expect(classifyClientAgent(request('/v1/chat/completions', {
      'user-agent': 'Kilo-Code/4.2',
    }))).toBe('kilo-code');
    expect(classifyClientAgent(request('/v1/chat/completions', {
      'user-agent': 'crush/0.8',
    }))).toBe('crush');
  });
});
