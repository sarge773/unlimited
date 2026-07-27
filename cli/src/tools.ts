import path from 'node:path';
import type {
  CatalogModel,
  GenerateContext,
  Generation,
  ToolDefinition,
} from './types.js';

function rootUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function v1Url(url: string): string {
  return `${rootUrl(url)}/v1`;
}

function primaryModel(models: CatalogModel[]): CatalogModel {
  return models.find(model => model.id !== 'auto' && model.available !== false)
    ?? models.find(model => model.id !== 'auto')
    ?? { id: 'auto', name: 'Auto', context_window: 128_000 };
}

function contextWindow(model: CatalogModel): number {
  return model.context_window ?? model.context_length ?? 128_000;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function claude(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  const directory = ctx.profile === 'default'
    ? path.join(ctx.homeDir, '.claude')
    : path.join(ctx.homeDir, '.claude', 'profiles', ctx.profile);
  return {
    files: [{
      path: path.join(directory, 'settings.json'),
      format: 'json',
      sensitive: true,
      value: {
        env: {
          ANTHROPIC_BASE_URL: rootUrl(ctx.url),
          ANTHROPIC_AUTH_TOKEN: ctx.apiKey,
          ANTHROPIC_MODEL: model.id,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model.id,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model.id,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model.id,
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow(model)),
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        },
      },
    }],
    notes: [
      ctx.profile === 'default'
        ? 'Claude Code will read this configuration automatically.'
        : `Launch with CLAUDE_CONFIG_DIR=${directory} claude`,
      'For zero-persistence credentials, prefer: freellmapi launch',
    ],
  };
}

function codex(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  const target = ctx.profile === 'default'
    ? path.join(ctx.homeDir, '.codex', 'config.toml')
    : path.join(ctx.homeDir, '.codex', `${ctx.profile}.config.toml`);
  const compact = Math.max(16_000, Math.floor(contextWindow(model) * 0.9));
  return {
    files: [{
      path: target,
      format: 'toml',
      content: [
        '# freellmapi:start',
        `model = ${JSON.stringify(model.id)}`,
        'model_provider = "freellmapi"',
        `model_context_window = ${contextWindow(model)}`,
        `model_auto_compact_token_limit = ${compact}`,
        'tool_output_token_limit = 20000',
        '',
        '[model_providers.freellmapi]',
        'name = "FreeLLMAPI"',
        `base_url = ${JSON.stringify(v1Url(ctx.url))}`,
        'wire_api = "responses"',
        'env_key = "FREELLMAPI_API_KEY"',
        'requires_openai_auth = false',
        '# freellmapi:end',
        '',
      ].join('\n'),
    }],
    notes: [
      'Export FREELLMAPI_API_KEY before running codex; the key is not written to config.toml.',
      `Selected ${model.id} with a ${contextWindow(model)} token context window.`,
    ],
  };
}

function cline(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  const dir = path.join(ctx.homeDir, '.cline', 'data');
  const provider = {
    apiProvider: 'openai',
    openAiBaseUrl: rootUrl(ctx.url),
    openAiModelId: model.id,
  };
  return {
    files: [
      {
        path: path.join(dir, 'globalState.json'),
        format: 'json',
        value: {
          apiConfiguration: provider,
          planModeApiConfiguration: provider,
          actModeApiConfiguration: provider,
        },
      },
      {
        path: path.join(dir, 'secrets.json'),
        format: 'json',
        sensitive: true,
        value: { openAiApiKey: ctx.apiKey },
      },
    ],
    notes: ['Cline appends /v1/chat/completions, so its base URL is the server root.'],
  };
}

function continueDev(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  return {
    files: [{
      path: path.join(ctx.homeDir, '.continue', 'config.yaml'),
      format: 'yaml',
      content: [
        '# freellmapi:start',
        'models:',
        '  - name: FreeLLMAPI',
        '    provider: openai',
        `    model: ${yamlString(model.id)}`,
        `    apiBase: ${yamlString(v1Url(ctx.url))}`,
        '    apiKey: ${{ secrets.FREELLMAPI_API_KEY }}',
        '# freellmapi:end',
        '',
      ].join('\n'),
    }],
    notes: ['Add FREELLMAPI_API_KEY to Continue secrets; no raw key was written.'],
  };
}

function aider(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  return {
    files: [{
      path: path.join(ctx.homeDir, '.aider.conf.yml'),
      format: 'yaml',
      sensitive: true,
      content: [
        '# freellmapi:start',
        `openai-api-base: ${yamlString(rootUrl(ctx.url))}`,
        `openai-api-key: ${yamlString(ctx.apiKey)}`,
        `model: ${yamlString(`openai/${model.id}`)}`,
        '# freellmapi:end',
        '',
      ].join('\n'),
    }],
    notes: [
      `Environment-only alternative: OPENAI_API_BASE=${rootUrl(ctx.url)} OPENAI_API_KEY=… aider --model openai/${model.id}`,
    ],
  };
}

function opencode(ctx: GenerateContext): Generation {
  const modelEntries = Object.fromEntries(ctx.models
    .filter(model => model.id !== 'auto')
    .map(model => [model.id, {
      name: model.name ?? model.id,
      limit: { context: contextWindow(model) },
    }]));
  return {
    files: [{
      path: path.join(ctx.homeDir, '.config', 'opencode', 'opencode.json'),
      format: 'json',
      value: {
        $schema: 'https://opencode.ai/config.json',
        provider: {
          freellmapi: {
            npm: '@ai-sdk/openai-compatible',
            name: 'FreeLLMAPI',
            options: {
              baseURL: v1Url(ctx.url),
              apiKey: '{env:FREELLMAPI_API_KEY}',
            },
            models: modelEntries,
          },
        },
      },
    }],
    notes: ['Export FREELLMAPI_API_KEY before starting OpenCode.'],
  };
}

function goose(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  return {
    files: [{
      path: path.join(ctx.homeDir, '.config', 'goose', 'config.yaml'),
      format: 'yaml',
      content: [
        '# freellmapi:start',
        'GOOSE_PROVIDER: openai',
        `GOOSE_MODEL: ${yamlString(model.id)}`,
        `OPENAI_HOST: ${yamlString(rootUrl(ctx.url))}`,
        'OPENAI_API_KEY: ${FREELLMAPI_API_KEY}',
        '# freellmapi:end',
        '',
      ].join('\n'),
    }],
    notes: ['Export FREELLMAPI_API_KEY before starting Goose.'],
  };
}

function qwen(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  const dir = path.join(ctx.homeDir, '.qwen');
  return {
    files: [
      {
        path: path.join(dir, 'settings.json'),
        format: 'json',
        value: {
          model: model.id,
          modelProviders: {
            freellmapi: {
              name: 'FreeLLMAPI',
              baseUrl: v1Url(ctx.url),
              envKey: 'FREELLMAPI_API_KEY',
              apiFormat: 'openai',
            },
          },
        },
      },
      {
        path: path.join(dir, '.env'),
        format: 'env',
        sensitive: true,
        content: `FREELLMAPI_API_KEY=${ctx.apiKey}\n`,
      },
    ],
    notes: [
      `Native Gemini mode is also available at ${rootUrl(ctx.url)}/v1beta with GEMINI_API_KEY.`,
    ],
  };
}

function roo(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  const importPath = path.join(ctx.homeDir, '.roo', 'freellmapi.json');
  return {
    files: [{
      path: importPath,
      format: 'json',
      sensitive: true,
      value: {
        apiProvider: 'openai',
        openAiBaseUrl: v1Url(ctx.url),
        openAiApiKey: ctx.apiKey,
        openAiModelId: model.id,
      },
    }],
    notes: [`Set Roo Code's autoImportSettingsPath to ${importPath}.`],
  };
}

function kilo(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  return {
    files: [{
      path: path.join(ctx.homeDir, '.kilocode', 'auth.json'),
      format: 'json',
      sensitive: true,
      value: {
        freellmapi: {
          provider: 'openai-compatible',
          baseUrl: v1Url(ctx.url),
          apiKey: ctx.apiKey,
          model: model.id,
        },
      },
    }],
    notes: ['Select the freellmapi provider in Kilo Code after importing this auth file.'],
  };
}

function crush(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  return {
    files: [{
      path: path.join(ctx.homeDir, '.config', 'crush', 'crush.json'),
      format: 'json',
      value: {
        providers: {
          freellmapi: {
            type: 'openai-compatible',
            base_url: v1Url(ctx.url),
            api_key: '$FREELLMAPI_API_KEY',
            models: [{ id: model.id, context_window: contextWindow(model) }],
          },
        },
      },
    }],
    notes: ['Export FREELLMAPI_API_KEY before starting Crush.'],
  };
}

function cursor(ctx: GenerateContext): Generation {
  return {
    files: [],
    notes: [
      'Cursor sends model traffic through its cloud service, so localhost is not reachable from Cursor.',
      `Expose the gateway through a trusted HTTPS tunnel, then open Cursor Settings → Models, enable Override OpenAI Base URL, and enter <public-url>/v1.`,
      'Use a separately revocable URL token if the client cannot set an Authorization header.',
    ],
  };
}

function generic(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  return {
    files: [],
    notes: [
      `OPENAI_BASE_URL=${v1Url(ctx.url)}`,
      `OPENAI_API_KEY=${ctx.apiKey || '<unified-key>'}`,
      `OPENAI_MODEL=${model.id}`,
      `curl ${v1Url(ctx.url)}/chat/completions -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" -d '{"model":"${model.id}","messages":[{"role":"user","content":"Hello"}]}'`,
    ],
  };
}

const metadata = [
  ['claude', 'Claude Code', 'code', 'file', 'Anthropic Messages', 'root', 'setup-claude', 'https://docs.anthropic.com/en/docs/claude-code', claude],
  ['codex', 'Codex CLI', 'code', 'file', 'OpenAI Responses', '/v1', 'setup-codex', 'https://developers.openai.com/codex', codex],
  ['cline', 'Cline', 'code', 'file', 'OpenAI Chat', 'root', 'setup-cline', 'https://docs.cline.bot', cline],
  ['continue', 'Continue', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-continue', 'https://docs.continue.dev', continueDev],
  ['aider', 'Aider', 'code', 'file', 'OpenAI Chat', 'root', 'setup-aider', 'https://aider.chat/docs', aider],
  ['opencode', 'OpenCode', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-opencode', 'https://opencode.ai/docs', opencode],
  ['goose', 'Goose', 'agent', 'file', 'OpenAI Chat', 'root', 'setup-goose', 'https://block.github.io/goose', goose],
  ['qwen', 'Qwen Code', 'code', 'file', 'OpenAI or Gemini', '/v1', 'setup-qwen', 'https://qwenlm.github.io/qwen-code-docs', qwen],
  ['roo', 'Roo Code', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-roo', 'https://docs.roocode.com', roo],
  ['kilo', 'Kilo Code', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-kilo', 'https://kilocode.ai/docs', kilo],
  ['crush', 'Crush', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-crush', 'https://github.com/charmbracelet/crush', crush],
  ['cursor', 'Cursor', 'code', 'guide', 'OpenAI Chat', '/v1', 'setup-cursor', 'https://docs.cursor.com', cursor],
  ['generic', 'Generic OpenAI client', 'agent', 'guide', 'OpenAI Chat', '/v1', 'setup-generic', 'https://github.com/tashfeenahmed/freellmapi', generic],
] as const;

export const tools: ToolDefinition[] = metadata.map(([
  id,
  name,
  category,
  configType,
  protocol,
  baseUrlSupport,
  command,
  docsUrl,
  generate,
]) => ({
  id,
  name,
  category,
  configType,
  protocol,
  baseUrlSupport,
  command,
  docsUrl,
  generate,
}));

export function getTool(id: string): ToolDefinition | undefined {
  return tools.find(tool => tool.id === id);
}
