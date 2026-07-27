#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs';
import process from 'node:process';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyGeneratedFile, printDryRunDiff } from './config-files.js';
import { getTool, tools } from './tools.js';
import type { CatalogModel, GenerateContext } from './types.js';

interface CliOptions {
  url: string;
  apiKey?: string;
  profile: string;
  model?: string;
  dryRun: boolean;
}

function rootUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function parseArgs(argv: string[]): { command?: string; options: CliOptions } {
  const options: CliOptions = {
    url: process.env.FREELLMAPI_URL || 'http://localhost:3000',
    apiKey: process.env.FREELLMAPI_API_KEY,
    profile: 'default',
    dryRun: false,
  };
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-') && !command) {
      command = arg;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const [flag, inline] = arg.split('=', 2);
    const value = inline ?? argv[index + 1];
    if (flag === '--url' || flag === '--api-key' || flag === '--profile' || flag === '--model') {
      if (inline === undefined) index += 1;
      if (!value) throw new Error(`${flag} requires a value`);
      if (flag === '--url') options.url = value;
      else if (flag === '--api-key') options.apiKey = value;
      else if (flag === '--profile') options.profile = value;
      else options.model = value;
      continue;
    }
    if (arg !== '--help' && arg !== '-h') throw new Error(`Unknown option: ${arg}`);
  }
  return { command, options };
}

async function promptForKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'No API key supplied. Pass --api-key or set FREELLMAPI_API_KEY.',
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const value = (await rl.question('FreeLLMAPI unified API key: ')).trim();
    if (!value) throw new Error('An API key is required');
    return value;
  } finally {
    rl.close();
  }
}

async function catalog(url: string, apiKey: string): Promise<CatalogModel[]> {
  const response = await fetch(`${rootUrl(url)}/v1/models?available=true`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`Catalog request failed (HTTP ${response.status}): ${detail}`);
  }
  const body = await response.json() as { data?: CatalogModel[] };
  const models = body.data ?? [];
  if (!models.length) throw new Error('The live catalog returned no models');
  return models;
}

function help(): string {
  return [
    'FreeLLMAPI coding-agent setup',
    '',
    'Usage:',
    '  freellmapi <command> [--url URL] [--api-key KEY] [--profile NAME] [--dry-run]',
    '',
    'Commands:',
    ...tools.map(tool => `  ${tool.command.padEnd(17)} ${tool.name}`),
    '  launch            Run Claude Code with credentials injected into the child environment',
    '  launch-codex      Run Codex with provider overrides and injected credentials',
    '  list              List supported coding agents',
    '',
    'Environment:',
    '  FREELLMAPI_URL, FREELLMAPI_API_KEY',
  ].join('\n');
}

async function setup(command: string, options: CliOptions): Promise<void> {
  const tool = getTool(command.replace(/^setup-/, ''));
  if (!tool) throw new Error(`Unknown setup command '${command}'`);
  const apiKey = options.apiKey ?? await promptForKey();
  const models = await catalog(options.url, apiKey);
  const context: GenerateContext = {
    url: rootUrl(options.url),
    apiKey,
    profile: options.profile,
    models,
    homeDir: os.homedir(),
  };
  const generation = tool.generate(context);

  if (generation.files.length === 0) {
    for (const note of generation.notes) process.stdout.write(`${note}\n`);
    return;
  }

  for (const file of generation.files) {
    const result = applyGeneratedFile(file, options.dryRun);
    if (options.dryRun && result.changed) {
      process.stdout.write(`${printDryRunDiff(result)}\n`);
    } else if (result.changed) {
      process.stdout.write(`Updated ${result.path}\n`);
      if (result.backupPath) process.stdout.write(`Backup: ${result.backupPath}\n`);
    } else {
      process.stdout.write(`Unchanged ${result.path}\n`);
    }
  }
  for (const note of generation.notes) process.stdout.write(`\n${note}\n`);
}

async function launchClaude(options: CliOptions): Promise<number> {
  const apiKey = options.apiKey ?? await promptForKey();
  const models = await catalog(options.url, apiKey);
  const selected = options.model
    ?? (options.profile !== 'default' ? options.profile : undefined)
    ?? models.find(model => model.id !== 'auto' && model.available !== false)?.id
    ?? 'auto';
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: rootUrl(options.url),
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_MODEL: selected,
    ANTHROPIC_DEFAULT_OPUS_MODEL: selected,
    ANTHROPIC_DEFAULT_SONNET_MODEL: selected,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: selected,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  };
  const child = spawn('claude', [], { stdio: 'inherit', env });
  return await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

async function launchCodex(options: CliOptions): Promise<number> {
  const apiKey = options.apiKey ?? await promptForKey();
  const models = await catalog(options.url, apiKey);
  const selected = options.model
    ?? models.find(model => model.id !== 'auto' && model.available !== false)?.id
    ?? 'auto';
  const env = { ...process.env, FREELLMAPI_API_KEY: apiKey };
  const args = [
    '-c', 'model_provider="freellmapi"',
    '-c', `model=${JSON.stringify(selected)}`,
    '-c', `model_providers.freellmapi.base_url=${JSON.stringify(`${rootUrl(options.url)}/v1`)}`,
    '-c', 'model_providers.freellmapi.wire_api="responses"',
    '-c', 'model_providers.freellmapi.env_key="FREELLMAPI_API_KEY"',
    '-c', 'model_providers.freellmapi.requires_openai_auth=false',
  ];
  const child = spawn('codex', args, { stdio: 'inherit', env });
  return await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { command, options } = parseArgs(argv);
  if (!command || command === 'help' || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${help()}\n`);
    return 0;
  }
  if (command === 'list') {
    for (const tool of tools) {
      process.stdout.write(`${tool.id}\t${tool.protocol}\t${tool.baseUrlSupport}\n`);
    }
    return 0;
  }
  if (command.startsWith('setup-')) {
    await setup(command, options);
    return 0;
  }
  if (command === 'launch') return launchClaude(options);
  if (command === 'launch-codex') return launchCodex(options);
  throw new Error(`Unknown command '${command}'\n\n${help()}`);
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().then(
    code => { process.exitCode = code; },
    error => {
      process.stderr.write(`freellmapi: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
