import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { isLoopback } from '../../routes/ollama.js';

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  server.close();
  let json: any;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, body: json, headers: response.headers };
}

function seedGroq(): void {
  const key = encrypt('gsk_ollama_surface_test');
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', 'ollama-test', ?, ?, ?, 'healthy', 1)
  `).run(key.encrypted, key.iv, key.authTag);
}

describe('Ollama emulation', () => {
  let app: Express;
  let dashboardToken: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashboardToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM rate_limit_usage').run();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    setSetting('ollama_emulation', 'off');
    seedGroq();
  });

  afterEach(() => vi.restoreAllMocks());

  it('is closed by default and opens without auth only on loopback', async () => {
    expect((await request(app, 'GET', '/api/tags')).status).toBe(404);
    setSetting('ollama_emulation', 'open-loopback');
    const tags = await request(app, 'GET', '/api/tags');
    expect(tags.status).toBe(200);
    expect(tags.body.models.length).toBeGreaterThan(0);
    expect((await request(app, 'GET', '/api/version')).body.version).toContain('freellmapi');
  });

  it('does not treat LAN peers as loopback clients', () => {
    const peer = (remoteAddress: string) => ({
      socket: { remoteAddress },
    }) as any;
    expect(isLoopback(peer('127.0.0.1'))).toBe(true);
    expect(isLoopback(peer('::1'))).toBe(true);
    expect(isLoopback(peer('::ffff:127.0.0.1'))).toBe(true);
    expect(isLoopback(peer('192.168.1.20'))).toBe(false);
    expect(isLoopback(peer('10.0.0.5'))).toBe(false);
  });

  it('emits Ollama-compatible NDJSON chat frames', async () => {
    setSetting('ollama_emulation', 'open-loopback');
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        return new Response(
          'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{"content":"one"},"finish_reason":null}]}\n\n'
          + 'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{"content":" two"},"finish_reason":null}]}\n\n'
          + 'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
          + 'data: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return originalFetch(url, init);
    });
    const response = await request(app, 'POST', '/api/chat', {
      model: 'auto',
      messages: [{ role: 'user', content: 'count' }],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const frames = response.text.trim().split('\n').map(line => JSON.parse(line));
    expect(frames.slice(0, 2).map(frame => frame.message.content)).toEqual(['one', ' two']);
    expect(frames.at(-1).done).toBe(true);
    expect(frames.at(-1).done_reason).toBe('stop');
  });

  it('requires the unified bearer key in key-required mode', async () => {
    setSetting('ollama_emulation', 'key-required');
    expect((await request(app, 'GET', '/api/tags')).status).toBe(401);
    expect((await request(app, 'GET', '/api/tags', undefined, {
      Authorization: `Bearer ${getUnifiedApiKey()}`,
    })).status).toBe(200);
  });

  it('preserves the dashboard side of the legacy embeddings path collision', async () => {
    setSetting('ollama_emulation', 'open-loopback');
    const ollama = await request(app, 'POST', '/api/embeddings', {});
    expect(ollama.status).toBe(400);
    expect(ollama.body.error).toContain('invalid request');

    const dashboard = await request(app, 'POST', '/api/embeddings', {}, {
      Authorization: `Bearer ${dashboardToken}`,
    });
    expect(dashboard.status).toBe(404);
    expect(dashboard.text).not.toContain('invalid request');
  });
});
