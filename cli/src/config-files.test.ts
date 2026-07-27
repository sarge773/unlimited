import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyGeneratedFile, renderFile } from './config-files.js';

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('safe config writes', () => {
  it('deep-merges JSONC and retains leading comments', () => {
    const existing = '// user configuration\n{"theme":"dark","provider":{"other":true},}\n';
    const rendered = renderFile({
      path: '/unused',
      format: 'json',
      value: { provider: { freellmapi: true } },
    }, existing);
    expect(rendered).toContain('// user configuration');
    expect(JSON.parse(rendered.replace('// user configuration\n', ''))).toEqual({
      theme: 'dark',
      provider: { other: true, freellmapi: true },
    });
  });

  it('creates a timestamped backup before replacing a real file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-cli-'));
    temporary.push(directory);
    const target = path.join(directory, 'config.toml');
    fs.writeFileSync(target, 'user_setting = true\n');
    const result = applyGeneratedFile({
      path: target,
      format: 'toml',
      content: '# freellmapi:start\nmodel = "auto"\n# freellmapi:end\n',
    }, false);
    expect(result.backupPath).toBeTruthy();
    expect(fs.readFileSync(result.backupPath!, 'utf8')).toBe('user_setting = true\n');
    expect(fs.readFileSync(target, 'utf8')).toContain('user_setting = true');
    expect(fs.readFileSync(target, 'utf8')).toContain('model = "auto"');
  });

  it('does not write in dry-run mode', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-cli-'));
    temporary.push(directory);
    const target = path.join(directory, 'new.json');
    const result = applyGeneratedFile({
      path: target,
      format: 'json',
      value: { enabled: true },
    }, true);
    expect(result.changed).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });
});
