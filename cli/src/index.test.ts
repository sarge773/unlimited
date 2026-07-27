import { describe, expect, it } from 'vitest';
import { codexArgs, parseArgs } from './index.js';

describe('CLI arguments and launchers', () => {
  it('parses setup options before or after the command', () => {
    expect(parseArgs([
      '--url',
      'http://localhost:3001/v1',
      'setup-codex',
      '--profile=work',
      '--dry-run',
    ])).toMatchObject({
      command: 'setup-codex',
      options: {
        url: 'http://localhost:3001/v1',
        profile: 'work',
        dryRun: true,
      },
    });
  });

  it('rejects profile names that can escape the intended config directory', () => {
    expect(() => parseArgs(['setup-codex', '--profile', '../../outside']))
      .toThrow('--profile must use only');
    expect(() => parseArgs(['setup-codex', '--profile', '..']))
      .toThrow('--profile must use only');
  });

  it('rejects a missing option value instead of consuming the next flag', () => {
    expect(() => parseArgs(['setup-codex', '--profile', '--dry-run']))
      .toThrow('--profile requires a value');
  });

  it('passes a complete Responses provider to Codex', () => {
    const args = codexArgs('http://localhost:3001/v1/', 'coder');
    expect(args).toContain('model_provider="freellmapi"');
    expect(args).toContain('model="coder"');
    expect(args).toContain('model_providers.freellmapi.name="FreeLLMAPI"');
    expect(args).toContain(
      'model_providers.freellmapi.base_url="http://localhost:3001/v1"',
    );
    expect(args).toContain('model_providers.freellmapi.wire_api="responses"');
  });
});
