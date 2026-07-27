import fs from 'node:fs';
import path from 'node:path';
import {
  applyEdits,
  modify,
  parse,
  type ParseError,
} from 'jsonc-parser';
import type { GeneratedFile } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);
}

function mergeJson(existing: string, value: Record<string, unknown>): string {
  let rendered = existing.trim() ? existing : '{}\n';
  const errors: ParseError[] = [];
  const parsed = parse(rendered, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length || !isRecord(parsed)) {
    throw new Error('Existing JSON/JSONC cannot be parsed safely');
  }

  const formattingOptions = {
    insertSpaces: true,
    tabSize: 2,
    eol: '\n',
  };
  const applyPatch = (
    base: Record<string, unknown>,
    patch: Record<string, unknown>,
    parentPath: (string | number)[] = [],
  ) => {
    for (const [key, next] of Object.entries(patch)) {
      const current = base[key];
      const propertyPath = [...parentPath, key];
      if (isRecord(current) && isRecord(next)) {
        applyPatch(current, next, propertyPath);
        continue;
      }
      rendered = applyEdits(rendered, modify(
        rendered,
        propertyPath,
        next,
        { formattingOptions },
      ));
    }
  };
  applyPatch(parsed, value);
  return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}

function markerPattern(): RegExp {
  return new RegExp(
    `^[ \\t]*(?:#|//) freellmapi:start[\\s\\S]*?^[ \\t]*(?:#|//) freellmapi:end\\s*`,
    'm',
  );
}

function mergeMarked(existing: string, generated: string): string {
  const start = generated.match(/^[ \t]*(?:#|\/\/) freellmapi:start$/m)?.[0];
  const end = generated.match(/^[ \t]*(?:#|\/\/) freellmapi:end$/m)?.[0];
  if (!start || !end) return generated;
  const marked = markerPattern();
  if (marked.test(existing)) {
    return existing.replace(marked, `${generated.trimEnd()}\n`);
  }
  const separator = existing.length && !existing.endsWith('\n') ? '\n' : '';
  return `${existing}${separator}${existing.trim() ? '\n' : ''}${generated}`;
}

function topLevelYamlKey(line: string): string | undefined {
  return line.match(/^([A-Za-z0-9_-]+):(?:\s|$)/)?.[1];
}

function generatedYamlKeys(generated: string): Set<string> {
  return new Set(generated.split(/\r?\n/)
    .map(topLevelYamlKey)
    .filter((key): key is string => Boolean(key)));
}

function removeYamlKeys(existing: string, keys: Set<string>): string {
  const lines = existing.split(/\r?\n/);
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const key = topLevelYamlKey(lines[index]);
    if (!key || !keys.has(key)) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    index += 1;
    while (index < lines.length && !topLevelYamlKey(lines[index])) index += 1;
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function continueModelLines(generated: string): string[] {
  const lines = generated.split(/\r?\n/);
  const modelsIndex = lines.findIndex(line => line === 'models:');
  const endIndex = lines.findIndex(
    (line, index) => index > modelsIndex && line === '# freellmapi:end',
  );
  return lines.slice(modelsIndex + 1, endIndex < 0 ? undefined : endIndex);
}

function mergeContinueYaml(existing: string, generated: string): string {
  const generatedLines = generated.split(/\r?\n/);
  const missingHeader = ['name', 'version', 'schema']
    .filter(key => !existing.split(/\r?\n/).some(line => topLevelYamlKey(line) === key))
    .map(key => generatedLines.find(line => topLevelYamlKey(line) === key)!)
    .filter(Boolean);
  let lines = existing.split(/\r?\n/);
  const modelsIndex = lines.findIndex(line => topLevelYamlKey(line) === 'models');
  const modelLines = continueModelLines(generated);

  if (modelsIndex < 0) {
    const prefix = missingHeader.length ? `${missingHeader.join('\n')}\n` : '';
    const separator = existing.trim() ? '\n\n' : '';
    return `${prefix}${existing.trimEnd()}${separator}models:\n${modelLines.join('\n')}\n`;
  }

  let modelsEnd = modelsIndex + 1;
  while (modelsEnd < lines.length && !topLevelYamlKey(lines[modelsEnd])) modelsEnd += 1;
  const entryStart = lines.findIndex(
    (line, index) => index > modelsIndex
      && index < modelsEnd
      && /^\s{2}-\s+name:\s+["']?FreeLLMAPI["']?\s*$/.test(line),
  );
  if (entryStart >= 0) {
    let entryEnd = entryStart + 1;
    while (
      entryEnd < modelsEnd
      && !/^\s{2}-\s+/.test(lines[entryEnd])
      && !topLevelYamlKey(lines[entryEnd])
    ) {
      entryEnd += 1;
    }
    lines.splice(entryStart, entryEnd - entryStart, ...modelLines);
  } else {
    lines.splice(modelsEnd, 0, ...modelLines);
  }
  if (missingHeader.length) lines = [...missingHeader, ...lines];
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function mergeYaml(existing: string, generated: string): string {
  if (/^name: FreeLLMAPI$/m.test(generated) && /^models:$/m.test(generated)) {
    const withoutOldBlock = existing.replace(markerPattern(), '').trimEnd();
    return mergeContinueYaml(withoutOldBlock, generated);
  }
  if (!existing.trim()) return generated;
  if (/^# freellmapi:start$/m.test(existing)) return mergeMarked(existing, generated);
  const withoutConflicts = removeYamlKeys(existing, generatedYamlKeys(generated));
  return mergeMarked(withoutConflicts, generated);
}

function generatedTomlKeys(generated: string): Set<string> {
  const keys = new Set<string>();
  for (const line of generated.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

function generatedTomlTables(generated: string): Set<string> {
  const tables = new Set<string>();
  for (const line of generated.split(/\r?\n/)) {
    const match = line.match(/^\[([^\]]+)\]$/);
    if (match) tables.add(match[1]);
  }
  return tables;
}

function mergeToml(existing: string, generated: string): string {
  if (!existing.trim()) return generated;
  if (/^# freellmapi:start$/m.test(existing)) return mergeMarked(existing, generated);
  const keys = generatedTomlKeys(generated);
  const tables = generatedTomlTables(generated);
  const lines = existing.split(/\r?\n/);
  const output: string[] = [];
  let currentTable: string | undefined;
  for (const line of lines) {
    const table = line.match(/^\[([^\]]+)\]$/)?.[1];
    if (table) currentTable = table;
    if (currentTable && tables.has(currentTable)) continue;
    if (!currentTable) {
      const key = line.match(/^([A-Za-z0-9_.-]+)\s*=/)?.[1];
      if (key && keys.has(key)) continue;
    }
    output.push(line);
  }
  return mergeMarked(output.join('\n').trimEnd(), generated);
}

function mergeEnv(existing: string, generated: string): string {
  const replacements = new Map(
    generated.split(/\r?\n/)
      .filter(line => line && !line.startsWith('#') && line.includes('='))
      .map(line => [line.slice(0, line.indexOf('=')), line]),
  );
  const lines = existing.split(/\r?\n/);
  const seen = new Set<string>();
  const output = lines.map(line => {
    const separator = line.indexOf('=');
    if (separator < 1 || line.trimStart().startsWith('#')) return line;
    const key = line.slice(0, separator);
    const replacement = replacements.get(key);
    if (!replacement) return line;
    seen.add(key);
    return replacement;
  });
  for (const [key, line] of replacements) {
    if (!seen.has(key)) output.push(line);
  }
  return `${output.filter((line, index) => line || index < output.length - 1).join('\n')}\n`;
}

export function renderFile(file: GeneratedFile, existing = ''): string {
  if (file.format === 'json') return mergeJson(existing, file.value ?? {});
  if (file.format === 'env') return mergeEnv(existing, file.content ?? '');
  if (file.format === 'yaml') return mergeYaml(existing, file.content ?? '');
  return mergeToml(existing, file.content ?? '');
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export interface ApplyResult {
  path: string;
  changed: boolean;
  backupPath?: string;
  rendered: string;
  previous: string;
}

export function applyGeneratedFile(file: GeneratedFile, dryRun: boolean): ApplyResult {
  const exists = fs.existsSync(file.path);
  const previous = exists ? fs.readFileSync(file.path, 'utf8') : '';
  const rendered = renderFile(file, previous);
  if (rendered === previous) {
    return { path: file.path, changed: false, rendered, previous };
  }
  if (dryRun) {
    return { path: file.path, changed: true, rendered, previous };
  }

  fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
  let backupPath: string | undefined;
  if (exists) {
    backupPath = `${file.path}.backup-${timestamp()}`;
    fs.copyFileSync(file.path, backupPath);
  }
  const temporary = `${file.path}.freellmapi-${process.pid}.tmp`;
  fs.writeFileSync(temporary, rendered, { mode: file.sensitive ? 0o600 : 0o644 });
  fs.renameSync(temporary, file.path);
  if (file.sensitive) fs.chmodSync(file.path, 0o600);
  return { path: file.path, changed: true, backupPath, rendered, previous };
}

export function printDryRunDiff(result: ApplyResult): string {
  const oldLines = result.previous.split(/\r?\n/);
  const newLines = result.rendered.split(/\r?\n/);
  const lines = [`--- ${result.path}`, `+++ ${result.path}`];
  if (!result.previous) {
    lines.push(...newLines.map(line => `+${line}`));
    return lines.join('\n');
  }
  const prefix = oldLines.findIndex((line, index) => line !== newLines[index]);
  const changedAt = prefix < 0 ? 0 : prefix;
  lines.push(`@@ line ${changedAt + 1} @@`);
  lines.push(...oldLines.slice(changedAt).map(line => `-${line}`));
  lines.push(...newLines.slice(changedAt).map(line => `+${line}`));
  return lines.join('\n');
}
