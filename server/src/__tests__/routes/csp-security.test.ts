import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { loadConfig } from '../../lib/config.js';

async function getHeaders(app: Express, path: string, forwardedProto?: string): Promise<Headers> {
  const server = app.listen(0);
  const addr = server.address() as any;
  const headers: Record<string, string> = {};
  if (forwardedProto) headers['x-forwarded-proto'] = forwardedProto;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, { headers });
  server.close();
  return res.headers;
}

describe('CSP security headers', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('sets the Content-Security-Policy header on every response', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy');
    expect(csp).toBeTruthy();
  });

  it('restricts default-src to self', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
  });

  it('restricts script-src to self', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
  });

  it('allows inline styles for React hydration', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('does not set HSTS (local-only proxy)', async () => {
    const headers = await getHeaders(app, '/api/ping');
    expect(headers.get('strict-transport-security')).toBeNull();
  });
});

// #682: upgrade-insecure-requests broke plain-HTTP LAN installs because the
// browser rewrites /assets/* to https:// on an origin with no TLS. The directive
// is now gated by request protocol + the CSP_UPGRADE_INSECURE_REQUESTS env.
describe('CSP upgrade-insecure-requests (#682)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('omits upgrade-insecure-requests on plain HTTP (LAN)', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('emits upgrade-insecure-requests behind an HTTPS reverse proxy (X-Forwarded-Proto)', async () => {
    const headers = await getHeaders(app, '/api/ping', 'https');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain('upgrade-insecure-requests');
  });
});

describe('CSP_UPGRADE_INSECURE_REQUESTS env override (#682)', () => {
  let app: Express;
  const envKey = 'CSP_UPGRADE_INSECURE_REQUESTS';

  afterAll(() => {
    delete process.env[envKey];
  });

  it('force-on: emits the directive even on plain HTTP', async () => {
    process.env[envKey] = 'true';
    app = createApp(loadConfig());
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('force-off: omits the directive even behind an HTTPS reverse proxy', async () => {
    process.env[envKey] = 'false';
    app = createApp(loadConfig());
    const headers = await getHeaders(app, '/api/ping', 'https');
    const csp = headers.get('content-security-policy')!;
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});
