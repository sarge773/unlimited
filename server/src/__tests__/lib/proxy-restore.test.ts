import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';
import {
  restoreProxySettings,
  getProxyUrl,
  isProxyEnabled,
  getProxyBypassPlatforms,
  applyProxyUrl,
  applyProxyEnabled,
  applyProxyBypass,
} from '../../lib/proxy.js';

// #949: the desktop embedder builds the app without server/src/index.ts, so
// the proxy state it starts with is whatever the module defaults are — an
// empty URL. The URL the user saved through PUT /api/settings/proxy sits in
// the settings table, ignored until the next re-save. restoreProxySettings()
// is the single hydration step both entry points now call after initDb; this
// test pins that the DB value actually reaches the process state.

const PROXY_ENV_VARS = ['PROXY_URL', 'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];

function clearProxyEnv(): void {
  for (const name of PROXY_ENV_VARS) {
    delete process.env[name];
    delete process.env[name.toLowerCase()];
  }
}

let closed = false;

beforeEach(() => {
  clearProxyEnv();
  // Reset to the module defaults so each case starts from "fresh process".
  applyProxyUrl('');
  applyProxyEnabled(true);
  applyProxyBypass('');
});

afterAll(() => {
  if (!closed) {
    getDb().close();
    closed = true;
  }
});

describe('restoreProxySettings (desktop embedder hydration, #949)', () => {
  it('loads a saved proxy URL, enabled flag and bypass list from the settings table', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    setSetting('proxy_url', 'socks5h://127.0.0.1:9050');
    setSetting('proxy_enabled', '1');
    setSetting('proxy_bypass', 'groq,openrouter');

    restoreProxySettings();

    expect(getProxyUrl()).toBe('socks5h://127.0.0.1:9050');
    expect(isProxyEnabled()).toBe(true);
    expect(getProxyBypassPlatforms()).toEqual(['groq', 'openrouter']);
  });

  it('respects a disabled proxy saved across a restart', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    setSetting('proxy_url', 'http://127.0.0.1:3128');
    setSetting('proxy_enabled', '0');

    restoreProxySettings();

    expect(getProxyUrl()).toBe('http://127.0.0.1:3128');
    expect(isProxyEnabled()).toBe(false);
  });

  it('keeps the defaults when nothing was ever saved', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    restoreProxySettings();

    expect(getProxyUrl()).toBe('');
    expect(isProxyEnabled()).toBe(true);
    expect(getProxyBypassPlatforms()).toEqual([]);
  });

  it('lets the PROXY_URL env var outrank the saved value, as before', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    setSetting('proxy_url', 'http://saved:3128');
    process.env.PROXY_URL = 'http://env:8080';

    restoreProxySettings();

    expect(getProxyUrl()).toBe('http://env:8080');
  });
});
