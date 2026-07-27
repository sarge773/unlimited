import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tools } from './tools.js';
import type { GenerateContext } from './types.js';

const context: GenerateContext = {
  url: 'http://localhost:3000',
  apiKey: 'freellmapi-test-key',
  profile: 'default',
  homeDir: '/home/tester',
  models: [
    {
      id: 'fast-coder',
      name: 'Fast Coder',
      available: true,
      context_window: 131072,
    },
    {
      id: 'reasoning-model',
      name: 'Reasoning Model',
      available: true,
      context_window: 262144,
    },
  ],
};

describe('tool generators', () => {
  for (const tool of tools) {
    it(`${tool.command} has stable golden output`, () => {
      expect(tool.generate(context)).toMatchSnapshot();
    });
  }

  it('keeps the dashboard metadata export in sync with the tool catalog', () => {
    const expected = tools.map(({ generate: _generate, ...tool }) => tool);
    const packageMetadata = JSON.parse(fs.readFileSync(
      path.resolve(import.meta.dirname, '../tools.json'),
      'utf8',
    ));
    const dashboardMetadata = JSON.parse(fs.readFileSync(
      path.resolve(import.meta.dirname, '../../client/src/data/agent-tools.json'),
      'utf8',
    ));
    expect(packageMetadata).toEqual(expected);
    expect(dashboardMetadata).toEqual(expected);
  });
});
