import fs from 'node:fs';
import path from 'node:path';
import type { GeneratedFile } from './types.js';

function stripJsonComments(source: string): string {
  let out = '';
  let string = false;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === '\n') {
        lineComment = false;
        out += current;
      }
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (string) {
      out += current;
      if (escape) escape = false;
      else if (current === '\\') escape = true;
      else if (current === '"') string = false;
      continue;
    }
    if (current === '"') {
      string = true;
      out += current;
    } else if (current === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else {
      out += current;
    }
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] = current
      && value
      && typeof current === 'object'
      && typeof value === 'object'
      && !Array.isArray(current)
      && !Array.isArray(value)
      ? deepMerge(
        current as Record<string, unknown>,
        value as Record<string, unknown>,
      )
      : value;
  }
  return result;
}

function leadingJsonComments(source: string): string {
  const match = source.match(/^\s*(?:(?:\/\/[^\n]*\n)|(?:\/\*[\s\S]*?\*\/\s*))+/);
  return match?.[0] ?? '';
}

function mergeJson(existing: string, value: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  if (existing.trim()) {
    try {
      const parsed = JSON.parse(stripJsonComments(existing));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed;
      }
    } catch (error: any) {
      throw new Error(`Existing JSON/JSONC cannot be parsed safely: ${error.message}`);
    }
  }
  return `${leadingJsonComments(existing)}${JSON.stringify(deepMerge(base, value), null, 2)}\n`;
}

function mergeMarked(existing: string, generated: string): string {
  const start = generated.match(/^[ \t]*(?:#|\/\/) freellmapi:start$/m)?.[0];
  const end = generated.match(/^[ \t]*(?:#|\/\/) freellmapi:end$/m)?.[0];
  if (!start || !end) return generated;
  const markerPattern = new RegExp(
    `^[ \\t]*(?:#|//) freellmapi:start[\\s\\S]*?^[ \\t]*(?:#|//) freellmapi:end\\s*`,
    'm',
  );
  if (markerPattern.test(existing)) {
    return existing.replace(markerPattern, generated.trimEnd());
  }
  const separator = existing.length && !existing.endsWith('\n') ? '\n' : '';
  return `${existing}${separator}${existing.trim() ? '\n' : ''}${generated}`;
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
  return mergeMarked(existing, file.content ?? '');
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
