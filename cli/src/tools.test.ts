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

  it('generates Cline current provider settings with repeatable selection', () => {
    const file = tools.find(tool => tool.id === 'cline')!.generate(context).files[0];
    const state = file.value as any;
    expect(file.path).toBe('/home/tester/.cline/data/settings/providers.json');
    expect(state).toMatchObject({
      version: 1,
      lastUsedProvider: 'openai-compatible',
    });
    expect(state.providers['openai-compatible']).toMatchObject({
      settings: {
        provider: 'openai-compatible',
        protocol: 'openai-chat',
        client: 'openai-compatible',
        model: 'fast-coder',
        baseUrl: 'http://localhost:3000/v1',
        apiKey: 'freellmapi-test-key',
        contextWindow: 131072,
        capabilities: ['streaming', 'tools'],
      },
      tokenSource: 'manual',
    });
  });

  it('generates a complete Continue v1 config with Agent tool support', () => {
    const config = tools.find(tool => tool.id === 'continue')!
      .generate(context).files[0].content!;
    expect(config).toContain('name: FreeLLMAPI');
    expect(config).toContain('version: 1.0.0');
    expect(config).toContain('schema: v1');
    expect(config).toContain('      - tool_use');
    expect(config).toContain('    apiKey: ${{ secrets.FREELLMAPI_API_KEY }}');
  });

  it('generates Goose custom-provider registration without persisting the key', () => {
    const generation = tools.find(tool => tool.id === 'goose')!.generate(context);
    const provider = generation.files.find(file => file.path.endsWith('freellmapi.json'))!.value as any;
    const selection = generation.files.find(file => file.path.endsWith('config.yaml'))!.content!;
    expect(provider).toMatchObject({
      name: 'freellmapi',
      engine: 'openai',
      api_key_env: 'FREELLMAPI_API_KEY',
      base_url: 'http://localhost:3000/v1',
      requires_auth: true,
      dynamic_models: false,
    });
    expect(provider.models.map((model: any) => model.name)).toEqual([
      'fast-coder',
      'reasoning-model',
    ]);
    expect(selection).toContain('GOOSE_PROVIDER: freellmapi');
    expect(JSON.stringify(generation)).not.toContain('freellmapi-test-key');
  });

  it('generates Qwen Code provider catalogs using a supported auth type', () => {
    const generation = tools.find(tool => tool.id === 'qwen')!.generate(context);
    const settings = generation.files.find(file => file.path.endsWith('settings.json'))!.value as any;
    expect(settings.security.auth.selectedType).toBe('openai');
    expect(settings.model).toEqual({ name: 'fast-coder' });
    expect(settings.modelProviders.openai.protocol).toBe('openai');
    expect(settings.modelProviders.openai.models).toHaveLength(2);
    expect(settings.modelProviders.openai.models[0]).toMatchObject({
      id: 'fast-coder',
      envKey: 'FREELLMAPI_API_KEY',
      baseUrl: 'http://localhost:3000/v1',
      generationConfig: { contextWindowSize: 131072 },
    });
    expect(settings.modelProviders).not.toHaveProperty('freellmapi');
  });

  it('wraps Roo Code imports in the documented provider profile envelope', () => {
    const config = tools.find(tool => tool.id === 'roo')!
      .generate(context).files[0].value as any;
    expect(config.providerProfiles.currentApiConfigName).toBe('freellmapi');
    expect(config.providerProfiles.apiConfigs.freellmapi).toMatchObject({
      apiProvider: 'openai',
      openAiBaseUrl: 'http://localhost:3000/v1',
      openAiModelId: 'fast-coder',
    });
    expect(config.globalSettings).toEqual({});
  });

  it('writes Kilo trusted global config with every catalog model', () => {
    const file = tools.find(tool => tool.id === 'kilo')!.generate(context).files[0];
    const config = file.value as any;
    expect(file.path).toBe('/home/tester/.config/kilo/kilo.jsonc');
    expect(config.$schema).toBe('https://app.kilo.ai/config.json');
    expect(config.model).toBe('openai-compatible/fast-coder');
    expect(config.provider['openai-compatible'].options).toEqual({
      apiKey: '{env:FREELLMAPI_API_KEY}',
      baseURL: 'http://localhost:3000/v1',
    });
    expect(Object.keys(config.provider['openai-compatible'].models)).toEqual([
      'fast-coder',
      'reasoning-model',
    ]);
    expect(config.provider['openai-compatible'].models['fast-coder']).toMatchObject({
      tool_call: true,
      limit: { context: 131072, output: 8192 },
    });
    expect(JSON.stringify(config)).not.toContain('freellmapi-test-key');
  });

  it('uses Crush openai-compat schema and lists every catalog model', () => {
    const config = tools.find(tool => tool.id === 'crush')!
      .generate(context).files[0].value as any;
    expect(config.$schema).toBe('https://charm.land/crush.json');
    expect(config.providers.freellmapi.type).toBe('openai-compat');
    expect(config.providers.freellmapi.models.map((model: any) => model.id)).toEqual([
      'fast-coder',
      'reasoning-model',
    ]);
    for (const model of config.providers.freellmapi.models) {
      expect(model).toMatchObject({
        cost_per_1m_in: 0,
        cost_per_1m_out: 0,
        cost_per_1m_in_cached: 0,
        cost_per_1m_out_cached: 0,
        can_reason: false,
        supports_attachments: false,
      });
    }
  });

  it('uses /v1 for every OpenAI-compatible generated base URL', () => {
    for (const tool of tools.filter(entry => entry.protocol.startsWith('OpenAI'))) {
      expect(tool.baseUrlSupport, tool.id).toBe('/v1');
    }
    expect(tools.find(tool => tool.id === 'claude')!.baseUrlSupport).toBe('root');
  });

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
