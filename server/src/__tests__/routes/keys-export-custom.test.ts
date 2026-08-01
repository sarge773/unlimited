import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// #687: Export of keys did not contain custom keys. Custom endpoints are
// stored as their own api_keys rows with platform='custom' and a per-endpoint
// base_url; the previous filter silently dropped every custom endpoint because
// their key row is often the 'no-key' sentinel. These tests cover the full
// round-trip — export (json/env/csv) of a custom endpoint, then re-import of
// that export restores the endpoint row.

let dashToken = '';
let app: Express;

async function request(
  app: Express,
  method: string,
  path: string,
  opts: { body?: unknown; form?: { field: string; content: string; filename: string }[]; headers?: Record<string, string> } = {},
) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${dashToken}`,
    ...(opts.headers ?? {}),
  };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  } else if (opts.form) {
    const boundary = '----vitestboundary' + Math.random().toString(16);
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    const parts: string[] = [];
    for (const f of opts.form) {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${f.content}\r\n`);
    }
    parts.push(`--${boundary}--\r\n`);
    body = parts.join('');
  }
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, { method, headers, body });
  const data = await res.text();
  server.close();
  return { status: res.status, text: data, json: () => JSON.parse(data) };
}

async function registerCustom(
  baseUrl: string,
  model: string,
  apiKey?: string,
  label?: string,
) {
  return request(app, 'POST', '/api/keys/custom', {
    body: { baseUrl, model, apiKey, label },
  });
}

async function exportFormat(format: 'json' | 'env' | 'csv') {
  return request(app, 'GET', `/api/keys/export?format=${format}`, {
    headers: { 'x-reauth-password': 'password123' },
  });
}

async function importFile(content: string, filename: string) {
  return request(app, 'POST', '/api/keys/import', {
    form: [{ field: 'file', content, filename }],
  });
}

describe('Keys export/import — custom endpoints (#687)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  it('exports a custom endpoint in json format with baseUrl', async () => {
    await registerCustom('http://localhost:11434/v1', 'llama3:8b', 'sk-test-1', 'My Ollama');

    const { status, text } = await exportFormat('json');
    expect(status).toBe(200);
    const json = JSON.parse(text);
    expect(json.keys).toHaveLength(1);
    expect(json.keys[0].platform).toBe('custom');
    expect(json.keys[0].baseUrl).toBe('http://localhost:11434/v1');
    expect(json.keys[0].key).toBe('sk-test-1');
  });

  it('exports a keyless custom endpoint (no-key sentinel) in json', async () => {
    // LM Studio with auth off registers without an apiKey.
    await registerCustom('http://192.168.1.10:1234/v1', 'local-model', undefined, 'Local LM Studio');

    const { status, text } = await exportFormat('json');
    expect(status).toBe(200);
    const json = JSON.parse(text);
    expect(json.keys).toHaveLength(1);
    expect(json.keys[0].platform).toBe('custom');
    expect(json.keys[0].baseUrl).toBe('http://192.168.1.10:1234/v1');
  });

  it('exports custom endpoints in csv format with base_url column', async () => {
    await registerCustom('http://localhost:11434/v1', 'llama3:8b', 'sk-test-1', 'My Ollama');

    const { status, text } = await exportFormat('csv');
    expect(status).toBe(200);
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('platform,key,label,base_url');
    // The custom row carries the base_url in the 4th column.
    expect(lines[1]).toContain('http://localhost:11434/v1');
    expect(lines[1]).toContain('custom');
  });

  it('exports custom endpoints in env format with CUSTOM_BASE_URL/CUSTOM_KEY', async () => {
    await registerCustom('http://localhost:11434/v1', 'llama3:8b', 'sk-test-1', 'My Ollama');

    const { status, text } = await exportFormat('env');
    expect(status).toBe(200);
    expect(text).toContain('CUSTOM_BASE_URL=http://localhost:11434/v1');
    expect(text).toContain('CUSTOM_KEY=sk-test-1');
  });

  it('round-trips a custom endpoint through json export and re-import', async () => {
    await registerCustom('http://localhost:11434/v1', 'llama3:8b', 'sk-test-1', 'My Ollama');
    // Capture the export BEFORE wiping, so it carries the registered endpoint.
    const { text: exportText } = await exportFormat('json');
    expect(exportText).toContain('http://localhost:11434/v1');
    getDb().prepare('DELETE FROM api_keys').run(); // wipe — simulate fresh install

    // Re-import the export
    const importRes = await importFile(exportText, 'freellmapi-keys.json');
    expect(importRes.status).toBe(200);
    const importBody = importRes.json();
    expect(importBody.imported).toBe(1);

    // The endpoint row is restored with base_url and the credential.
    const rows = getDb().prepare("SELECT platform, base_url, label FROM api_keys WHERE platform = 'custom'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].base_url).toBe('http://localhost:11434/v1');
  });

  it('round-trips a custom endpoint through csv export and re-import', async () => {
    await registerCustom('http://localhost:11434/v1', 'llama3:8b', 'sk-test-1', 'My Ollama');
    const { text: exportText } = await exportFormat('csv');
    expect(exportText).toContain('http://localhost:11434/v1');
    getDb().prepare('DELETE FROM api_keys').run();

    const importRes = await importFile(exportText, 'freellmapi-keys.csv');
    expect(importRes.status).toBe(200);
    const importBody = importRes.json();
    expect(importBody.imported).toBe(1);

    const rows = getDb().prepare("SELECT base_url FROM api_keys WHERE platform = 'custom'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].base_url).toBe('http://localhost:11434/v1');
  });

  it('round-trips a custom endpoint through env export and re-import', async () => {
    await registerCustom('http://localhost:11434/v1', 'llama3:8b', 'sk-test-1', 'My Ollama');
    const { text: exportText } = await exportFormat('env');
    expect(exportText).toContain('CUSTOM_BASE_URL=http://localhost:11434/v1');
    getDb().prepare('DELETE FROM api_keys').run();

    const importRes = await importFile(exportText, 'freellmapi-keys.env');
    expect(importRes.status).toBe(200);
    const importBody = importRes.json();
    expect(importBody.imported).toBe(1);

    const rows = getDb().prepare("SELECT base_url FROM api_keys WHERE platform = 'custom'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].base_url).toBe('http://localhost:11434/v1');
  });
});
