import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeLayers,
  codexLayers,
  diagnose,
  exitCodeFor,
  normalizeUrl,
  probeGateway,
  sameGateway,
} from './doctor.js';

const temporary: string[] = [];
function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-doctor-'));
  temporary.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fetch double that answers /livez exactly as the real gateway does. */
function gatewayFetch(body: unknown = { status: 'ok', version: '0.7.0', uptime_s: 12 }): typeof fetch {
  return (async () => ({ status: 200, json: async () => body })) as unknown as typeof fetch;
}
const deadFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

function writeClaudeSettings(home: string, value: Record<string, unknown>): void {
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(value));
}

function writeCodexConfig(home: string, toml: string): void {
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.toml'), toml);
}

describe('url comparison', () => {
  it('ignores trailing slashes, a /v1 suffix, and case', () => {
    expect(normalizeUrl('http://Localhost:3000/v1/')).toBe('http://localhost:3000');
    expect(sameGateway('http://localhost:3000', 'http://localhost:3000/v1')).toBe(true);
    expect(sameGateway('http://localhost:3000', 'http://localhost:3001')).toBe(false);
    expect(sameGateway(undefined, 'http://localhost:3000')).toBe(false);
  });
});

describe('claude precedence', () => {
  it('ranks a settings env block ABOVE the inherited shell environment', () => {
    // The easy thing to get backwards, and I did: Claude Code writes each
    // `env` entry into the process environment at startup, REPLACING what the
    // shell exported. The shell is the lowest layer, not the highest.
    const home = tempHome();
    writeClaudeSettings(home, { env: { ANTHROPIC_BASE_URL: 'http://localhost:3000' } });
    const layers = claudeLayers({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, home, tempHome());

    expect(layers[0]).toMatchObject({ value: 'http://localhost:3000', effective: true });
    expect(layers[1]).toMatchObject({ value: 'https://api.anthropic.com', effective: false });
  });

  it('uses the shell value when no settings file names one', () => {
    expect(claudeLayers({ ANTHROPIC_BASE_URL: 'http://localhost:3000' }, tempHome(), tempHome())[0])
      .toMatchObject({ value: 'http://localhost:3000', effective: true });
  });

  it('ranks project-local settings above the user scope', () => {
    const home = tempHome();
    const project = tempHome();
    writeClaudeSettings(home, { env: { ANTHROPIC_BASE_URL: 'http://user:1' } });
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://project-local:2' } }),
    );

    expect(claudeLayers({}, home, project)[0])
      .toMatchObject({ value: 'http://project-local:2', effective: true });
  });

  it('honours CLAUDE_CONFIG_DIR for the user scope', () => {
    // Relocates the user scope wholesale; missing it reads a settings file the
    // running tool never opens.
    const home = tempHome();
    const configDir = tempHome();
    writeClaudeSettings(home, { env: { ANTHROPIC_BASE_URL: 'http://ignored:1' } });
    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://relocated:2' } }),
    );

    expect(claudeLayers({ CLAUDE_CONFIG_DIR: configDir }, home, tempHome())[0]?.value)
      .toBe('http://relocated:2');
  });

  it('reports no layers rather than throwing on absent or malformed settings', () => {
    const home = tempHome();
    expect(claudeLayers({}, home, tempHome())).toEqual([]);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
    expect(claudeLayers({}, home, tempHome())).toEqual([]);
  });
});

describe('codex precedence', () => {
  it('resolves the SELECTED provider, not the first base_url in the file', () => {
    // Codex names a provider and the provider carries the url. Reading any
    // base_url would report a provider the user is not selecting.
    const home = tempHome();
    writeCodexConfig(home, [
      'model_provider = "freellmapi"',
      '',
      '[model_providers.other]',
      'base_url = "http://not-this-one:9999/v1"',
      '',
      '[model_providers.freellmapi]',
      'base_url = "http://localhost:3000/v1"',
    ].join('\n'));

    expect(codexLayers({}, home)[0]).toMatchObject({
      value: 'http://localhost:3000/v1',
      effective: true,
    });
  });

  it('reads the dotted-key spelling too', () => {
    const home = tempHome();
    writeCodexConfig(home, [
      'model_provider = "freellmapi"',
      'model_providers.freellmapi.base_url = "http://localhost:3000/v1"',
    ].join('\n'));
    expect(codexLayers({}, home)[0]?.value).toBe('http://localhost:3000/v1');
  });

  it('honours CODEX_HOME over the default location', () => {
    const home = tempHome();
    const alternate = tempHome();
    writeCodexConfig(home, 'model_provider = "a"\n[model_providers.a]\nbase_url = "http://default:1/v1"');
    writeCodexConfig(alternate, 'model_provider = "b"\n[model_providers.b]\nbase_url = "http://override:2/v1"');

    const layers = codexLayers({ CODEX_HOME: path.join(alternate, '.codex') }, home);
    expect(layers[0]?.value).toBe('http://override:2/v1');
  });

  it('records a selected provider that names no base_url instead of skipping it', () => {
    const home = tempHome();
    writeCodexConfig(home, 'model_provider = "freellmapi"\n');
    const layer = codexLayers({}, home)[0];
    expect(layer.effective).toBe(true);
    expect(layer.value).toBeUndefined();
    expect(layer.source).toContain('no base_url found');
  });
});

describe('verdicts', () => {
  const url = 'http://localhost:3000';

  it('routed only when the tool reaches THIS gateway', async () => {
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: { ANTHROPIC_BASE_URL: url },
      homeDir: tempHome(), cwd: tempHome(),
      fetchImpl: gatewayFetch(),
    });
    expect(report.verdict).toBe('routed');
    expect(report.gateway?.version).toBe('0.7.0');
  });

  it('elsewhere — not routed — when the tool reaches a different host that is alive', async () => {
    // The regression this guards: reporting `routed` for a Claude Code pinned
    // to api.anthropic.com, because it does reach what it is configured to
    // reach. That is a confident wrong answer to the question being asked.
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      homeDir: tempHome(), cwd: tempHome(),
      fetchImpl: gatewayFetch(),
    });
    expect(report.verdict).toBe('elsewhere');
    expect(report.detail).toContain('does not touch this gateway');
  });

  it('elsewhere when the right port answers, but not the way this gateway does', async () => {
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: { ANTHROPIC_BASE_URL: url },
      homeDir: tempHome(), cwd: tempHome(),
      fetchImpl: gatewayFetch({ hello: 'some other service' }),
    });
    expect(report.verdict).toBe('elsewhere');
  });

  it('shadowed names the layer that wins, and the value it beat', async () => {
    const home = tempHome();
    writeClaudeSettings(home, { env: { ANTHROPIC_BASE_URL: url } });
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      homeDir: home, cwd: tempHome(),
      fetchImpl: gatewayFetch(),
    });

    expect(report.verdict).toBe('shadowed');
    // The settings block is what wins, so it is what shadows — and the shell
    // export the user probably set by hand is what got overridden.
    expect(report.shadowedBy).toContain('settings.json');
    expect(report.detail).toContain('process environment');
    expect(report.detail).toContain('https://api.anthropic.com');
  });

  it('unreachable when the configured endpoint answers nothing', async () => {
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: { ANTHROPIC_BASE_URL: url },
      homeDir: tempHome(), cwd: tempHome(),
      fetchImpl: deadFetch,
    });
    expect(report.verdict).toBe('unreachable');
    expect(report.detail).toContain('ECONNREFUSED');
  });

  it('unknown when nothing configures the tool at all', async () => {
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: {},
      homeDir: tempHome(), cwd: tempHome(),
      fetchImpl: gatewayFetch(),
    });
    expect(report.verdict).toBe('unknown');
    expect(report.detail).toContain('vendor default');
  });

  it('unknown, not a crash, for a tool doctor does not model', async () => {
    const report = await diagnose('aider', { expectedUrl: url, env: {}, homeDir: tempHome() });
    expect(report.verdict).toBe('unknown');
    expect(report.detail).toContain('claude');
  });
});

describe('probeGateway', () => {
  it('requires all three /livez fields before claiming identity', async () => {
    // /livez carries no product marker, so the shape is the only evidence
    // available. Two of three fields is not it.
    expect((await probeGateway('http://x', gatewayFetch({ status: 'ok', version: '1' }))).identified)
      .toBe(false);
    expect((await probeGateway('http://x', gatewayFetch())).identified).toBe(true);
  });

  it('treats a non-JSON body as reachable but unidentified', async () => {
    const htmlFetch = (async () => ({
      status: 200,
      json: async () => { throw new Error('not json'); },
    })) as unknown as typeof fetch;
    expect(await probeGateway('http://x', htmlFetch))
      .toMatchObject({ reachable: true, identified: false });
  });
});

describe('exit code', () => {
  it('is zero only when every tool is routed', () => {
    expect(exitCodeFor([{ verdict: 'routed' } as never])).toBe(0);
    expect(exitCodeFor([{ verdict: 'routed' } as never, { verdict: 'elsewhere' } as never])).toBe(1);
    expect(exitCodeFor([{ verdict: 'unknown' } as never])).toBe(1);
  });
});
