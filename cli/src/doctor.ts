// `freellmapi doctor` — does this tool's traffic actually reach this gateway?
//
// The load-bearing constraint: the verdict must be computed in a process that
// INHERITS THE USER'S SESSION ENVIRONMENT. The server cannot answer this
// question, because the failure being diagnosed is a request that never
// arrives — there is nothing in any server-side log to look at. So the check
// resolves each tool's effective connection the way that tool resolves it, in
// this process, and only then asks the gateway whether it is alive.
//
// The motivating failure is real and silent: a launcher that sets
// ANTHROPIC_BASE_URL into the process environment overrides the `env` block of
// ~/.claude/settings.json, so a user who edited settings.json is routed
// somewhere else entirely and nothing says so.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 'elsewhere' is not decoration. Without it the first real run of this command
// reported `OK claude: routed` for a Claude Code pinned to api.anthropic.com —
// technically "it reaches what it is configured to reach", and precisely the
// confident-wrong answer the command exists to prevent. `routed` now means
// "reaches THIS gateway", which is the only question the user is asking.
export type Verdict = 'routed' | 'elsewhere' | 'shadowed' | 'unreachable' | 'unknown';

export interface Layer {
  /** Where the value came from, in the tool's own vocabulary. */
  source: string;
  value?: string;
  /** True for the layer whose value the tool will actually use. */
  effective: boolean;
}

export interface ToolReport {
  tool: string;
  verdict: Verdict;
  /** Every layer that set a value, highest precedence first. */
  layers: Layer[];
  /** The base URL the tool will really use, if one could be determined. */
  effectiveUrl?: string;
  /** For 'shadowed': the layer that beat the one the user probably edited. */
  shadowedBy?: string;
  /** Gateway identity, when the effective URL was probed. */
  gateway?: GatewayProbe;
  detail: string;
}

export interface GatewayProbe {
  reachable: boolean;
  /** Whether the response looks like this product. See identifyGateway. */
  identified: boolean;
  version?: string;
  status?: number;
  error?: string;
}

/** Normalize for comparison: scheme+host+port, no trailing slash, no /v1. */
export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').toLowerCase();
}

export function sameGateway(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeUrl(a) === normalizeUrl(b);
}

function readJsonIfPresent(file: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    // Claude Code's settings.json is strict JSON, not JSONC.
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Platform locations of Claude Code's MANAGED settings — the layer nothing
 *  else can override. */
export function managedSettingsPaths(platform: string = process.platform): string[] {
  if (platform === 'win32') return ['C:\\Program Files\\ClaudeCode\\managed-settings.json'];
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

/** ANTHROPIC_BASE_URL out of a settings file's `env` block. */
function envBlockUrl(file: string): string | undefined {
  const block = readJsonIfPresent(file)?.env;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined;
  const value = (block as Record<string, unknown>).ANTHROPIC_BASE_URL;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Claude Code's base-URL layers, HIGHEST PRECEDENCE FIRST.
 *
 * The ordering that matters, and the one it is easy to get backwards: a
 * settings file's `env` block BEATS the inherited shell environment. Claude
 * Code writes each `env` entry into the process environment at startup and
 * again when the file changes, replacing what the shell exported. So the
 * process environment is the LOWEST layer here, not the highest.
 *
 * The familiar "my launcher overrode my settings.json" case is not a
 * counter-example: a launcher that wins is writing MANAGED settings, which
 * outrank every other scope — note that the rest of that same `env` block
 * still applies, which is what makes the override so hard to see by reading
 * config alone.
 */
export function claudeLayers(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  cwd: string = process.cwd(),
  platform: string = process.platform,
): Layer[] {
  const layers: Layer[] = [];

  for (const managed of managedSettingsPaths(platform)) {
    const value = envBlockUrl(managed);
    if (value) layers.push({ source: `${managed} (MANAGED env block)`, value, effective: false });
  }

  for (const file of [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    // CLAUDE_CONFIG_DIR relocates the user scope wholesale; missing it reads
    // a settings file the running tool never opens.
    path.join(env.CLAUDE_CONFIG_DIR ?? path.join(homeDir, '.claude'), 'settings.json'),
  ]) {
    const value = envBlockUrl(file);
    if (value) layers.push({ source: `${file} (env block)`, value, effective: false });
  }

  if (env.ANTHROPIC_BASE_URL) {
    layers.push({
      source: 'ANTHROPIC_BASE_URL (process environment)',
      value: env.ANTHROPIC_BASE_URL,
      effective: false,
    });
  }

  if (layers.length) layers[0].effective = true;
  return layers;
}

/**
 * Codex's base-URL layers, highest precedence first.
 *
 * Codex resolves a PROVIDER, not a URL: `model_provider` names a key in the
 * `[model_providers]` table and that entry carries base_url. Reading only
 * `base_url` occurrences would report a provider the user is not selecting,
 * so the selected name is resolved first.
 */
export function codexLayers(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Layer[] {
  const layers: Layer[] = [];
  const configPath = path.join(env.CODEX_HOME ?? path.join(homeDir, '.codex'), 'config.toml');
  let toml = '';
  try {
    toml = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  } catch {
    toml = '';
  }

  const selected = /^\s*model_provider\s*=\s*["']([^"']+)["']/m.exec(toml)?.[1];
  if (selected) {
    // Both spellings the file format allows: a dotted key and a section.
    const dotted = new RegExp(
      `^\\s*model_providers\\.${escapeRegExp(selected)}\\.base_url\\s*=\\s*["']([^"']+)["']`,
      'm',
    ).exec(toml)?.[1];
    const section = sectionValue(toml, `model_providers.${selected}`, 'base_url');
    const url = dotted ?? section;
    if (url) {
      layers.push({
        source: `${configPath} ([model_providers.${selected}] base_url)`,
        value: url,
        effective: false,
      });
    } else {
      layers.push({
        source: `${configPath} (model_provider = "${selected}", no base_url found)`,
        effective: false,
      });
    }
  }

  if (layers.length) layers[0].effective = true;
  return layers;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Value of `key` inside a `[section]` block of a TOML document. */
function sectionValue(toml: string, section: string, key: string): string | undefined {
  const lines = toml.split('\n');
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      inSection = header[1].trim() === section;
      continue;
    }
    if (!inSection) continue;
    const match = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*["']([^"']+)["']`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Probe a base URL's identity.
 *
 * IMPORTANT LIMIT, stated rather than papered over: `/livez` answers
 * `{status, version, uptime_s}` and carries NO product identifier, so a 200
 * with that exact shape is evidence, not proof — another service could serve
 * the same three keys. `identified` therefore means "responds the way this
 * gateway responds", and the report says so. Asserting identity harder would
 * need either an authenticated call (the CLI does not have a key here) or a
 * product marker the server does not currently emit.
 */
export async function probeGateway(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayProbe> {
  let response: Response;
  try {
    response = await fetchImpl(`${normalizeUrl(baseUrl)}/livez`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return {
      reachable: false,
      identified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let body: Record<string, unknown> = {};
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    return { reachable: true, identified: false, status: response.status, error: 'response was not JSON' };
  }
  const identified = typeof body.status === 'string'
    && typeof body.version === 'string'
    && typeof body.uptime_s === 'number';
  return {
    reachable: true,
    identified,
    status: response.status,
    version: typeof body.version === 'string' ? body.version : undefined,
  };
}

export interface DoctorOptions {
  /** The gateway the user believes they are using (--url / FREELLMAPI_URL). */
  expectedUrl: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Project-scoped settings are resolved relative to this. */
  cwd?: string;
  fetchImpl?: typeof fetch;
}

const LAYER_RESOLVERS: Record<string, (env: NodeJS.ProcessEnv, homeDir: string, cwd: string) => Layer[]> = {
  claude: (env, homeDir, cwd) => claudeLayers(env, homeDir, cwd),
  codex: (env, homeDir) => codexLayers(env, homeDir),
};

export const DOCTOR_TOOLS = Object.keys(LAYER_RESOLVERS);

export async function diagnose(tool: string, options: DoctorOptions): Promise<ToolReport> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const resolve = LAYER_RESOLVERS[tool];
  if (!resolve) {
    return {
      tool,
      verdict: 'unknown',
      layers: [],
      detail: `doctor does not know how ${tool} resolves its endpoint. Known tools: ${DOCTOR_TOOLS.join(', ')}.`,
    };
  }

  const layers = resolve(env, homeDir, options.cwd ?? process.cwd());
  const effective = layers.find(layer => layer.effective);

  if (!effective?.value) {
    return {
      tool,
      verdict: 'unknown',
      layers,
      detail: layers.length
        ? 'A configuration layer was found but names no base URL, so the tool falls back to its vendor default.'
        : `No configuration found. ${tool} will use its vendor default endpoint, not this gateway.`,
    };
  }

  const gateway = await probeGateway(effective.value, options.fetchImpl);

  // A lower-precedence layer naming a DIFFERENT url is the silent-override
  // case: the user edited that file and something outranks it.
  const overridden = layers.find(
    layer => !layer.effective && layer.value && !sameGateway(layer.value, effective.value),
  );

  if (!gateway.reachable) {
    return {
      tool,
      verdict: 'unreachable',
      layers,
      effectiveUrl: effective.value,
      gateway,
      detail: `${tool} is configured to use ${effective.value}, but nothing answered there (${gateway.error}).`,
    };
  }

  if (overridden) {
    return {
      tool,
      verdict: 'shadowed',
      layers,
      effectiveUrl: effective.value,
      shadowedBy: effective.source,
      gateway,
      detail:
        `${overridden.source} sets ${overridden.value}, but ${effective.source} outranks it, `
        + `so ${tool} actually uses ${effective.value}.`,
    };
  }

  // Two distinct ways to be pointed somewhere else, and both must fail the
  // check: a different host entirely, or the right host answering nothing that
  // looks like this gateway.
  if (!sameGateway(effective.value, options.expectedUrl)) {
    return {
      tool,
      verdict: 'elsewhere',
      layers,
      effectiveUrl: effective.value,
      gateway,
      detail:
        `${tool} reaches ${effective.value}, NOT the ${options.expectedUrl} this command was pointed at. `
        + 'Its traffic does not touch this gateway.',
    };
  }

  if (!gateway.identified) {
    return {
      tool,
      verdict: 'elsewhere',
      layers,
      effectiveUrl: effective.value,
      gateway,
      detail:
        `Something is listening at ${effective.value} and ${tool} would reach it, but it did not answer `
        + '/livez the way this gateway does — so it is probably a different service on that port.',
    };
  }

  return {
    tool,
    verdict: 'routed',
    layers,
    effectiveUrl: effective.value,
    gateway,
    detail: `${tool} reaches ${effective.value}${gateway.version ? ` (gateway v${gateway.version})` : ''}.`,
  };
}

const SYMBOL: Record<Verdict, string> = {
  routed: 'OK  ',
  elsewhere: 'FAIL',
  shadowed: 'WARN',
  unreachable: 'FAIL',
  unknown: '?   ',
};

export function formatReport(report: ToolReport): string {
  const lines = [`${SYMBOL[report.verdict]} ${report.tool}: ${report.verdict}`, `     ${report.detail}`];
  for (const layer of report.layers) {
    lines.push(`     ${layer.effective ? '->' : '  '} ${layer.source}${layer.value ? ` = ${layer.value}` : ''}`);
  }
  if (report.gateway?.reachable && !report.gateway.identified) {
    lines.push('     note: something answered, but not with this gateway\'s /livez shape.');
  }
  return lines.join('\n');
}

/** Exit code: 0 when every tool is routed, 1 otherwise — so it is usable in a
 *  script, not only by eye. */
export function exitCodeFor(reports: ToolReport[]): number {
  return reports.every(report => report.verdict === 'routed') ? 0 : 1;
}
