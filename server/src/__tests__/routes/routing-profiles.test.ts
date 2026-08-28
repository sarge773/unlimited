import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy } from '../../services/router.js';
import { setRoutingProfiles } from '../../services/routing-profiles.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(data); } catch { /* SSE / non-JSON */ }
  return { status: res.status, body: json, headers: res.headers };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

// Insert a catalog row + fallback_config entry, returning its model_db_id.
function addModel(platform: string, modelId: string, displayName: string, priority: number, intelligenceRank = 5): number {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision)
    VALUES (?, ?, ?, ?, 5, 'Large', 100, NULL, NULL, NULL, '~10M', 131072, 1, 0)
  `).run(platform, modelId, displayName, intelligenceRank);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  return id;
}

function addKey(platform: string): void {
  const db = getDb();
  const { encrypted, iv, authTag } = encrypt(`test-key-${platform}`);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, `${platform}-key`, encrypted, iv, authTag);
}

function completion(model: string, content: string) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Two DIFFERENT logical models in a profile named "coding" (#1026): a small
// fast coder first, a big smart one as the fallback. Distinct platforms so
// x-routed-via tells us exactly who answered.
describe('Routing profiles: capability groups addressable as a model id', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    setRoutingStrategy('priority');
    addModel('groq', 'qwen3-coder-fast', 'Qwen3 Coder Fast', 2);
    addModel('cerebras', 'deepseek-r1-coder', 'DeepSeek R1 Coder', 3, 1);
    addKey('groq');
    addKey('cerebras');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CRUD via /api/routing-profiles validates slugs and reports unresolvable refs', async () => {
    const bad = await request(app, 'POST', '/api/routing-profiles', {
      slug: 'auto', name: 'Auto', models: [],
    });
    expect(bad.status).toBe(400);

    const created = await request(app, 'POST', '/api/routing-profiles', {
      slug: 'coding',
      name: 'Coding',
      description: 'code well',
      models: [
        { ref: 'groq:qwen3-coder-fast', priority: 10 },
        { ref: 'ghost-model', priority: 20 },
        { ref: 'cerebras:deepseek-r1-coder', priority: 30 },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.unresolvedRefs).toEqual(['ghost-model']);

    const dup = await request(app, 'POST', '/api/routing-profiles', {
      slug: 'coding', name: 'Dup', models: [],
    });
    expect(dup.status).toBe(409);

    const list = await request(app, 'GET', '/api/routing-profiles');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].memberCount).toBe(3);

    const updated = await request(app, 'PUT', '/api/routing-profiles/coding', {
      name: 'Coding v2',
      models: [{ ref: 'groq:qwen3-coder-fast', priority: 1 }],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Coding v2');

    const del = await request(app, 'DELETE', '/api/routing-profiles/coding');
    expect(del.status).toBe(200);
    expect((await request(app, 'GET', '/api/routing-profiles')).body).toHaveLength(0);

    // Re-create for the routing tests below.
    const again = await request(app, 'POST', '/api/routing-profiles', {
      slug: 'coding',
      name: 'Coding',
      models: [
        { ref: 'groq:qwen3-coder-fast', priority: 1 },
        { ref: 'cerebras:deepseek-r1-coder', priority: 2 },
      ],
    });
    expect(again.status).toBe(201);
  });

  it('/v1/models advertises the profile as a first-class id', async () => {
    setRoutingProfiles([{
      slug: 'coding', name: 'Coding', description: '',
      models: [
        { ref: 'groq:qwen3-coder-fast', priority: 1 },
        { ref: 'cerebras:deepseek-r1-coder', priority: 2 },
      ],
    }]);
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);
    const entry = body.data.find((m: any) => m.id === 'coding');
    expect(entry).toBeDefined();
    expect(entry.owned_by).toBe('freellmapi-profile');
    // Best-member bounds: context window and intelligence of the strongest member.
    expect(entry.context_window).toBe(131072);
  });

  it("model: 'coding' fails over across DIFFERENT models (groq 429 → cerebras)", async () => {
    setRoutingProfiles([{
      slug: 'coding', name: 'Coding', description: '',
      models: [
        { ref: 'groq:qwen3-coder-fast', priority: 1 },
        { ref: 'cerebras:deepseek-r1-coder', priority: 2 },
      ],
    }]);
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
      if (u.includes('api.cerebras.ai')) return completion('deepseek-r1-coder', 'answer from cerebras');
      return orig(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'coding',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toContain('cerebras');
    expect(headers.get('x-routed-via')).toContain('cerebras');
  });

  it('profile priority beats the active strategy (strict arrangement)', async () => {
    setRoutingProfiles([{
      slug: 'coding', name: 'Coding', description: '',
      models: [
        { ref: 'groq:qwen3-coder-fast', priority: 1 },
        { ref: 'cerebras:deepseek-r1-coder', priority: 2 },
      ],
    }]);
    // DeepSeek R1 is far smarter; under the smartest strategy plain routing
    // would pick it. The profile pins Qwen3 to the head anyway.
    setRoutingStrategy('smartest');
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) return completion('qwen3-coder-fast', 'from groq');
      if (u.includes('api.cerebras.ai')) return completion('deepseek-r1-coder', 'from cerebras');
      return orig(url, init);
    });

    const { status, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'coding',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);
    expect(headers.get('x-routed-via')).toContain('groq');
  });

  it('a real model id still wins over a same-named profile (no hijacking)', async () => {
    setRoutingProfiles([{
      slug: 'qwen3-coder-fast', name: 'Shadow', description: '',
      models: [{ ref: 'cerebras:deepseek-r1-coder', priority: 1 }],
    }]);
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) return completion('qwen3-coder-fast', 'the real groq model');
      if (u.includes('api.cerebras.ai')) return completion('deepseek-r1-coder', 'SHOULD NOT ANSWER');
      return orig(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'qwen3-coder-fast',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);
    expect(body.choices[0].message.content).toContain('groq');
  });

  it('a fully-unresolvable profile falls through to model_not_found', async () => {
    setRoutingProfiles([{
      slug: 'ghost', name: 'Ghost', description: '',
      models: [{ ref: 'no-such-model', priority: 1 }],
    }]);
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'ghost',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(404);
    expect(body.error.code).toBe('model_not_found');
  });

  it('all profile members down → honest exhaustion, never an off-profile answer', async () => {
    setRoutingProfiles([{
      slug: 'coding', name: 'Coding', description: '',
      models: [
        { ref: 'groq:qwen3-coder-fast', priority: 1 },
        { ref: 'cerebras:deepseek-r1-coder', priority: 2 },
      ],
    }]);
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com') || u.includes('api.cerebras.ai')) {
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
      }
      return orig(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'coding',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(429);
    expect(body.choices).toBeUndefined();
  });
});
