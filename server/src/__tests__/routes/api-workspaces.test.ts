import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

let app: Express;
let dashboardToken = '';
let defaultProfile: { id: number; apiKey: string };
let codingProfile: { id: number; slug: string; apiKey: string };

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  server.close();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function dashboardHeaders(profileId?: number): Record<string, string> {
  return {
    Authorization: `Bearer ${dashboardToken}`,
    ...(profileId ? { 'X-Profile-ID': String(profileId) } : {}),
  };
}

function apiHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

describe('API workspaces', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.PROXY_URL;
    initDb(':memory:');
    app = createApp();
    dashboardToken = mintDashboardToken();

    const defaultRow = getDb().prepare(
      "SELECT id, api_key AS apiKey FROM profiles WHERE type = 'default'",
    ).get() as { id: number; apiKey: string };
    defaultProfile = defaultRow;

    const created = await request('POST', '/api/profiles', {
      name: 'Coding',
      slug: 'coding',
      sourceProfileId: defaultProfile.id,
    }, dashboardHeaders());
    expect(created.status).toBe(201);
    const keyRow = getDb().prepare(
      'SELECT id, slug, api_key AS apiKey FROM profiles WHERE id = ?',
    ).get(created.body.id) as { id: number; slug: string; apiKey: string };
    codingProfile = keyRow;
  });

  it('serves Default at both /v1 and /default/v1 and a custom workspace at its slug', async () => {
    const [root, alias, coding] = await Promise.all([
      request('GET', '/v1/models', undefined, apiHeaders(defaultProfile.apiKey)),
      request('GET', '/default/v1/models', undefined, apiHeaders(defaultProfile.apiKey)),
      request('GET', '/coding/v1/models', undefined, apiHeaders(codingProfile.apiKey)),
    ]);
    expect(root.status).toBe(200);
    expect(alias.status).toBe(200);
    expect(coding.status).toBe(200);
    expect(alias.body).toEqual(root.body);
  });

  it('rejects a key from another workspace and unknown workspace slugs', async () => {
    const [wrongNamed, wrongDefault, missing] = await Promise.all([
      request('GET', '/coding/v1/models', undefined, apiHeaders(defaultProfile.apiKey)),
      request('GET', '/v1/models', undefined, apiHeaders(codingProfile.apiKey)),
      request('GET', '/missing-profile/v1/models', undefined, apiHeaders(codingProfile.apiKey)),
    ]);
    expect(wrongNamed.status).toBe(401);
    expect(wrongDefault.status).toBe(401);
    expect(missing.status).toBe(404);
  });

  it('keeps model allowlists and routing settings independent', async () => {
    const defaultChain = await request(
      'GET', '/api/fallback', undefined, dashboardHeaders(defaultProfile.id),
    );
    const codingChain = await request(
      'GET', '/api/fallback', undefined, dashboardHeaders(codingProfile.id),
    );
    expect(defaultChain.status).toBe(200);
    expect(codingChain.status).toBe(200);
    expect(codingChain.body.length).toBeGreaterThan(0);

    const disabledId = codingChain.body[0].modelDbId as number;
    const changed = codingChain.body.map((row: any) => ({
      modelDbId: row.modelDbId,
      priority: row.priority,
      enabled: row.modelDbId === disabledId ? false : row.enabled,
    }));
    expect((await request(
      'PUT', '/api/fallback', changed, dashboardHeaders(codingProfile.id),
    )).status).toBe(200);
    expect((await request(
      'PUT', '/api/fallback/routing', { strategy: 'fastest' }, dashboardHeaders(codingProfile.id),
    )).status).toBe(200);

    const [defaultAfter, codingAfter, defaultRouting, codingRouting] = await Promise.all([
      request('GET', '/api/fallback', undefined, dashboardHeaders(defaultProfile.id)),
      request('GET', '/api/fallback', undefined, dashboardHeaders(codingProfile.id)),
      request('GET', '/api/fallback/routing', undefined, dashboardHeaders(defaultProfile.id)),
      request('GET', '/api/fallback/routing', undefined, dashboardHeaders(codingProfile.id)),
    ]);
    expect(defaultAfter.body.find((row: any) => row.modelDbId === disabledId).enabled).toBe(true);
    expect(codingAfter.body.find((row: any) => row.modelDbId === disabledId).enabled).toBe(false);
    expect(defaultRouting.body.strategy).not.toBe('fastest');
    expect(codingRouting.body.strategy).toBe('fastest');
  });

  it('returns the selected workspace key on the dashboard', async () => {
    const [defaultKey, codingKey] = await Promise.all([
      request('GET', '/api/settings/api-key', undefined, dashboardHeaders(defaultProfile.id)),
      request('GET', '/api/settings/api-key', undefined, dashboardHeaders(codingProfile.id)),
    ]);
    expect(defaultKey.body.apiKey).toBe(defaultProfile.apiKey);
    expect(codingKey.body.apiKey).toBe(codingProfile.apiKey);
    expect(codingKey.body.apiKey).not.toBe(defaultKey.body.apiKey);
  });

  it('keeps outbound proxy settings independent per workspace', async () => {
    expect((await request(
      'PUT',
      '/api/settings/proxy',
      { proxyUrl: 'http://default-proxy.test:8080', enabled: true },
      dashboardHeaders(defaultProfile.id),
    )).status).toBe(200);
    expect((await request(
      'PUT',
      '/api/settings/proxy',
      { proxyUrl: 'socks5://coding-proxy.test:1080', enabled: false },
      dashboardHeaders(codingProfile.id),
    )).status).toBe(200);

    const [defaultProxy, codingProxy] = await Promise.all([
      request('GET', '/api/settings/proxy', undefined, dashboardHeaders(defaultProfile.id)),
      request('GET', '/api/settings/proxy', undefined, dashboardHeaders(codingProfile.id)),
    ]);
    expect(defaultProxy.body).toMatchObject({
      proxyUrl: 'http://default-proxy.test:8080',
      enabled: true,
      active: true,
    });
    expect(codingProxy.body).toMatchObject({
      proxyUrl: 'socks5://coding-proxy.test:1080',
      enabled: false,
      active: false,
    });
  });

  it('filters raw and durable analytics by workspace', async () => {
    const db = getDb();
    const insertRequest = db.prepare(`
      INSERT INTO requests
        (platform, model_id, status, input_tokens, output_tokens, profile_id, profile_slug)
      VALUES ('test', 'model', 'success', ?, ?, ?, ?)
    `);
    insertRequest.run(10, 4, defaultProfile.id, 'default');
    insertRequest.run(20, 8, codingProfile.id, codingProfile.slug);
    const hour = new Date().toISOString().slice(0, 13).replace('T', ' ') + ':00:00';
    db.prepare(`
      INSERT INTO profile_request_hourly
        (hour, profile_id, total_requests, success_count, error_count, input_tokens, output_tokens)
      VALUES (?, ?, 1, 1, 0, ?, ?)
      ON CONFLICT(hour, profile_id) DO UPDATE SET
        total_requests = total_requests + 1,
        success_count = success_count + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens
    `).run(hour, defaultProfile.id, 10, 4);
    db.prepare(`
      INSERT INTO profile_request_hourly
        (hour, profile_id, total_requests, success_count, error_count, input_tokens, output_tokens)
      VALUES (?, ?, 1, 1, 0, ?, ?)
      ON CONFLICT(hour, profile_id) DO UPDATE SET
        total_requests = total_requests + 1,
        success_count = success_count + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens
    `).run(hour, codingProfile.id, 20, 8);

    const [defaultSummary, codingSummary, defaultRequests, codingRequests] = await Promise.all([
      request('GET', '/api/analytics/summary?range=24h', undefined, dashboardHeaders(defaultProfile.id)),
      request('GET', '/api/analytics/summary?range=24h', undefined, dashboardHeaders(codingProfile.id)),
      request('GET', '/api/analytics/requests?range=24h', undefined, dashboardHeaders(defaultProfile.id)),
      request('GET', '/api/analytics/requests?range=24h', undefined, dashboardHeaders(codingProfile.id)),
    ]);
    expect(defaultSummary.body.totalInputTokens).toBe(10);
    expect(codingSummary.body.totalInputTokens).toBe(20);
    expect(defaultRequests.body.rows.every((row: any) => row.inputTokens === 10)).toBe(true);
    expect(codingRequests.body.rows.every((row: any) => row.inputTokens === 20)).toBe(true);
  });
});
