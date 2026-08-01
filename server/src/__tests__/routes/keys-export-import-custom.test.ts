import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { encrypt } from '../../lib/crypto.js';

// Round-trip coverage for #687: exporting keys must carry the base_url of
// custom OpenAI-compatible endpoints, and re-importing the file must restore
// the endpoint — not silently drop it.

let dashToken = '';

async function post(app: Express, path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${dashToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function exportText(app: Express, format: 'json' | 'env' | 'csv') {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/export?format=${format}`, {
    headers: { Authorization: `Bearer ${dashToken}`, 'x-reauth-password': 'password123' },
  });
  const text = await res.text();
  server.close();
  return { status: res.status, text };
}

async function multipartRequest(
  app: Express,
  path: string,
  field: 'file' | 'files',
  files: Array<{ filename: string; content: string; type?: string }>,
) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const form = new FormData();
  for (const file of files) {
    form.append(
      field,
      new Blob([file.content], { type: file.type ?? 'text/plain' }),
      file.filename,
    );
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${dashToken}` },
    body: form,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

// Insert a custom endpoint directly (the /custom flow needs a model
// registration; the DB row is all the export/import paths read).
function insertCustomKey(baseUrl: string, key: string, label = 'My Relay') {
  const db = getDb();
  const { encrypted, iv, authTag } = encrypt(key);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', ?, ?, ?, ?, 'unknown', 1, ?)
  `).run(label, encrypted, iv, authTag, baseUrl);
}

describe('Key export/import — custom endpoints round-trip (#687)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  it('JSON export includes baseUrl for custom keys', async () => {
    insertCustomKey('https://relay.example.com/v1', 'sk-relay-123', 'My Relay');
    const { status, text } = await exportText(app, 'json');
    expect(status).toBe(200);
    const parsed = JSON.parse(text);
    const custom = parsed.keys.find((k: any) => k.platform === 'custom');
    expect(custom).toMatchObject({
      platform: 'custom',
      key: 'sk-relay-123',
      label: 'My Relay',
      baseUrl: 'https://relay.example.com/v1',
    });
  });

  it('CSV export includes the base_url column for custom keys', async () => {
    insertCustomKey('https://relay.example.com/v1', 'sk-relay-123', 'My Relay');
    const { status, text } = await exportText(app, 'csv');
    expect(status).toBe(200);
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('platform,key,label,base_url');
    expect(lines[1]).toBe('"custom","sk-relay-123","My Relay","https://relay.example.com/v1"');
  });

  it('.env export pairs CUSTOM_BASE_URL with CUSTOM_KEY', async () => {
    insertCustomKey('https://relay.example.com/v1', 'sk-relay-123', 'My Relay');
    const { status, text } = await exportText(app, 'env');
    expect(status).toBe(200);
    expect(text).toContain('# My Relay');
    expect(text).toContain('CUSTOM_BASE_URL_1=https://relay.example.com/v1');
    expect(text).toContain('CUSTOM_KEY_1=sk-relay-123');
  });

  it('custom endpoints survive a JSON export → import round-trip', async () => {
    insertCustomKey('https://relay.example.com/v1', 'sk-relay-123', 'My Relay');
    const { text } = await exportText(app, 'json');

    // Wipe everything, then import the file back.
    getDb().prepare('DELETE FROM api_keys').run();
    const { status, body } = await multipartRequest(app, '/api/keys/import', 'file', [
      { filename: 'freellmapi-keys.json', content: text, type: 'application/json' },
    ]);
    expect(status).toBe(200);
    expect(body.imported).toBe(1);
    expect(body.skipped).toEqual([]);

    const row = getDb().prepare("SELECT platform, base_url, label FROM api_keys WHERE platform = 'custom'").get() as any;
    expect(row).toMatchObject({ platform: 'custom', base_url: 'https://relay.example.com/v1', label: 'My Relay' });
  });

  it('custom endpoints survive a CSV export → import round-trip', async () => {
    insertCustomKey('https://relay.example.com/v1', 'sk-relay-123', 'My Relay');
    const { text } = await exportText(app, 'csv');

    getDb().prepare('DELETE FROM api_keys').run();
    const { status, body } = await multipartRequest(app, '/api/keys/import', 'file', [
      { filename: 'freellmapi-keys.csv', content: text },
    ]);
    expect(status).toBe(200);
    expect(body.imported).toBe(1);

    const row = getDb().prepare("SELECT platform, base_url FROM api_keys WHERE platform = 'custom'").get() as any;
    expect(row).toMatchObject({ platform: 'custom', base_url: 'https://relay.example.com/v1' });
  });

  it('custom endpoints survive a .env export → import round-trip', async () => {
    insertCustomKey('https://relay.example.com/v1', 'sk-relay-123', 'My Relay');
    const { text } = await exportText(app, 'env');

    getDb().prepare('DELETE FROM api_keys').run();
    const { status, body } = await multipartRequest(app, '/api/keys/import', 'file', [
      { filename: 'freellmapi-keys.env', content: text },
    ]);
    expect(status).toBe(200);
    expect(body.imported).toBe(1);

    const row = getDb().prepare("SELECT platform, base_url FROM api_keys WHERE platform = 'custom'").get() as any;
    expect(row).toMatchObject({ platform: 'custom', base_url: 'https://relay.example.com/v1' });
  });

  it('import-selected restores custom keys when baseUrl is present', async () => {
    const { status, body } = await post(app, '/api/keys/import-selected', {
      keys: [
        { keyName: 'sk-relay-123', keyValue: 'sk-relay-123', platform: 'custom', baseUrl: 'https://relay.example.com/v1' },
      ],
    });
    expect(status).toBe(200);
    expect(body.imported).toBe(1);
    expect(body.errors).toEqual([]);

    const row = getDb().prepare("SELECT platform, base_url FROM api_keys WHERE platform = 'custom'").get() as any;
    expect(row).toMatchObject({ platform: 'custom', base_url: 'https://relay.example.com/v1' });
  });

  it('import-selected still rejects custom keys without a base URL', async () => {
    const { status, body } = await post(app, '/api/keys/import-selected', {
      keys: [
        { keyName: 'sk-relay-123', keyValue: 'sk-relay-123', platform: 'custom' },
      ],
    });
    expect(status).toBe(200);
    expect(body.imported).toBe(0);
    expect(body.errors[0].error).toContain('base URL');
  });
});
