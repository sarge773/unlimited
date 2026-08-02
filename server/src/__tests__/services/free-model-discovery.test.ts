// Unit tests for the free-model-discovery service. Uses the same in-memory DB
// pattern as the other service tests, with a mocked fetch to avoid hitting
// real APIs.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';

describe('free-model-discovery', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setupDb() {
    const { initDb } = await import('../../db/index.js');
    // Each test gets a fresh in-memory DB
    const db = initDb(`:memory:`);
    return db;
  }

  it('openrouter fetcher filters by pricing.prompt === "0"', async () => {
    const db = await setupDb();
    // Insert an openrouter api_key
    const { encrypt } = await import('../../lib/crypto.js');
    const key = encrypt('sk-or-test');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('openrouter', 'Openrouter', ?, ?, ?, 'healthy', 1)
    `).run(key.encrypted, key.iv, key.authTag);

    // Mock the openrouter /v1/models response: 3 models, 2 free + 1 paid.
    // Note: the in-memory DB starts with 17+ pre-seeded openrouter :free
    // models from V29; the discovery will retire all of them since they're
    // not in our mock. The test only asserts on the *added* set.
    const fakeResponse = {
      data: [
        { id: 'free/a:free', name: 'A', pricing: { prompt: '0', completion: '0' }, context_length: 100000, architecture: { modality: 'text->text' } },
        { id: 'free/b:free', name: 'B', pricing: { prompt: '0', completion: '0' }, context_length: 50000, architecture: { modality: 'text+image->text' } },
        { id: 'paid/c', name: 'C', pricing: { prompt: '0.0001', completion: '0.0002' }, context_length: 200000, architecture: { modality: 'text->text' } },
      ],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(fakeResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );

    const { refreshFreeModels } = await import('../../services/free-model-discovery.js');
    const result = await refreshFreeModels(['openrouter']);
    expect(result.scanned['openrouter']).toBe(2); // 2 free, 1 paid filtered
    expect(result.added.map(a => a.model_id).sort()).toEqual(['free/a:free', 'free/b:free']);

    // Verify the models were added to the catalog
    const catalog = db.prepare(`SELECT model_id FROM models WHERE platform='openrouter' AND model_id IN ('free/a:free', 'free/b:free') ORDER BY model_id`).all() as { model_id: string }[];
    expect(catalog.map(c => c.model_id)).toEqual(['free/a:free', 'free/b:free']);

    // Verify the vision support was inferred from architecture.modality
    const b = db.prepare(`SELECT supports_vision FROM models WHERE platform='openrouter' AND model_id='free/b:free'`).get() as { supports_vision: number };
    expect(b.supports_vision).toBe(1);

    fetchSpy.mockRestore();
    db.close();
  });

  it('tokenrouter fetcher uses the allowlist table', async () => {
    const db = await setupDb();
    const { encrypt } = await import('../../lib/crypto.js');
    const key = encrypt('sk-test');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('tokenrouter', 'TokenRouter', ?, ?, ?, 'healthy', 1)
    `).run(key.encrypted, key.iv, key.authTag);

    // Allowlist one model, and one that's not actually in tokenrouter
    db.prepare(`INSERT INTO cloud_provider_free_models (platform, model_id, probe_verified, notes) VALUES ('tokenrouter', 'minimax/cool-free', 1, 'test')`).run();
    db.prepare(`INSERT INTO cloud_provider_free_models (platform, model_id, probe_verified, notes) VALUES ('tokenrouter', 'fake/not-in-catalog', 0, 'test')`).run();

    // Mock the tokenrouter /v1/models response: includes only minimax/cool-free
    const fakeResponse = { data: [{ id: 'minimax/cool-free' }, { id: 'some/paid-model' }] };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(fakeResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );

    const { refreshFreeModels } = await import('../../services/free-model-discovery.js');
    const result = await refreshFreeModels(['tokenrouter']);
    // V30 seeds MiniMax-M3, so the allowlist has 2 entries. The tokenrouter
    // API mock returns only minimax/cool-free, so 1 is found, 1 is filtered
    // (not added because not in the live list).
    expect(result.scanned['tokenrouter']).toBe(1);

    fetchSpy.mockRestore();
    db.close();
  });

  it('retires auto_managed rows whose model disappeared from the live list', async () => {
    const db = await setupDb();
    const { encrypt } = await import('../../lib/crypto.js');
    const key = encrypt('sk-or-test');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('openrouter', 'Openrouter', ?, ?, ?, 'healthy', 1)
    `).run(key.encrypted, key.iv, key.authTag);

    // Pre-insert an auto_managed row for a model that WILL disappear
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, supports_vision, supports_tools)
      VALUES ('openrouter', 'gone/old:free', 'Old', 999, 9, 'Medium', 20, 200, NULL, NULL, '~6M', 131072, 0, 1)
    `).run();
    const modelId = (db.prepare(`SELECT id FROM models WHERE platform='openrouter' AND model_id='gone/old:free'`).get() as { id: number }).id;
    db.prepare(`
      INSERT INTO cloud_fallback_config (model_db_id, priority, enabled, auto_managed) VALUES (?, 50, 1, 1)
    `).run(modelId);

    // Now the API returns an empty free list
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );

    const { refreshFreeModels } = await import('../../services/free-model-discovery.js');
    const result = await refreshFreeModels(['openrouter']);
    expect(result.retired.map(r => r.model_id)).toContain('gone/old:free');

    // The row was disabled, not deleted
    const row = db.prepare(`SELECT enabled FROM cloud_fallback_config WHERE model_db_id = ?`).get(modelId) as { enabled: number };
    expect(row.enabled).toBe(0);

    fetchSpy.mockRestore();
    db.close();
  });

  it('does not retire manual (auto_managed=0) rows even if the model is gone from the live list', async () => {
    const db = await setupDb();
    const { encrypt } = await import('../../lib/crypto.js');
    const key = encrypt('sk-or-test');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('openrouter', 'Openrouter', ?, ?, ?, 'healthy', 1)
    `).run(key.encrypted, key.iv, key.authTag);

    // Manually-added row (auto_managed=0) for a model the API doesn't know
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, supports_vision, supports_tools)
      VALUES ('openrouter', 'manual/keep:free', 'Keep', 999, 9, 'Medium', 20, 200, NULL, NULL, '~6M', 131072, 0, 1)
    `).run();
    const modelId = (db.prepare(`SELECT id FROM models WHERE platform='openrouter' AND model_id='manual/keep:free'`).get() as { id: number }).id;
    db.prepare(`
      INSERT INTO cloud_fallback_config (model_db_id, priority, enabled, auto_managed) VALUES (?, 50, 1, 0)
    `).run(modelId);

    // API returns empty
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );

    const { refreshFreeModels } = await import('../../services/free-model-discovery.js');
    await refreshFreeModels(['openrouter']);

    // The manual row was NOT retired
    const row = db.prepare(`SELECT enabled FROM cloud_fallback_config WHERE model_db_id = ?`).get(modelId) as { enabled: number };
    expect(row.enabled).toBe(1);

    fetchSpy.mockRestore();
    db.close();
  });

  it('refreshFreeModels is idempotent — running twice produces the same chain', async () => {
    const db = await setupDb();
    const { encrypt } = await import('../../lib/crypto.js');
    const key = encrypt('sk-or-test');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('openrouter', 'Openrouter', ?, ?, ?, 'healthy', 1)
    `).run(key.encrypted, key.iv, key.authTag);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        data: [
          { id: 'free/x:free', name: 'X', pricing: { prompt: '0', completion: '0' }, context_length: 100000, architecture: { modality: 'text->text' } },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );

    const { refreshFreeModels } = await import('../../services/free-model-discovery.js');
    const r1 = await refreshFreeModels(['openrouter']);
    const r2 = await refreshFreeModels(['openrouter']);
    // The V29 seed has 17 openrouter :free rows in the cloud chain with
    // auto_managed=0 (manual). First refresh: 1 added (free/x:free), 17
    // retired (the V29 rows are not in the live mock response). Second
    // refresh: 0 added (already in catalog), 0 retired (already disabled).
    expect(r1.added.length).toBe(1);
    expect(r1.added[0].model_id).toBe('free/x:free');
    expect(r2.added.length).toBe(0);

    // The 'free/x:free' row should be in cloud_fallback_config exactly once
    const xCount = (db.prepare(`
      SELECT COUNT(*) AS c FROM cloud_fallback_config cfc
      JOIN models m ON m.id = cfc.model_db_id
      WHERE m.platform = 'openrouter' AND m.model_id = 'free/x:free'
    `).get() as { c: number }).c;
    expect(xCount).toBe(1);

    fetchSpy.mockRestore();
    db.close();
  });

  it('returns errors per-platform without throwing', async () => {
    const db = await setupDb();
    // No api_key for openrouter, so the fetch should fail
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('network down'); });

    const { refreshFreeModels } = await import('../../services/free-model-discovery.js');
    const result = await refreshFreeModels(['openrouter', 'tokenrouter']);
    // openrouter has no key -> error. tokenrouter has the V30-seeded
    // MiniMax-M3 in the allowlist, but no api_key configured, so the
    // tokenrouter fetcher falls back to "trust the allowlist" (returns the
    // row). No error. So only 1 error total.
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].platform).toBe('openrouter');

    fetchSpy.mockRestore();
    db.close();
  });
});
