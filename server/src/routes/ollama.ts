import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type {
  ChatMessage,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import { getSetting, getUnifiedApiKey } from '../db/index.js';
import { buildModelListing } from '../services/model-listing.js';
import { extractApiToken, timingSafeStringEqual } from './proxy.js';
import { runInboundChat, type InboundChatResult, type InboundChatWire } from '../lib/inbound-chat.js';
import { runEmbeddings, EmbeddingsError } from '../services/embeddings.js';
import { validateSession } from '../services/auth.js';

export const ollamaRouter = Router();

export type OllamaEmulationMode = 'off' | 'open-loopback' | 'key-required';

export function getOllamaEmulationMode(): OllamaEmulationMode {
  const stored = getSetting('ollama_emulation');
  return stored === 'open-loopback' || stored === 'key-required' ? stored : 'off';
}

export function isLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/i, '');
  return address === '127.0.0.1' || address === '::1';
}

function authorize(req: Request, res: Response): boolean {
  if ((req as Request & { urlTokenAuthenticated?: boolean }).urlTokenAuthenticated) {
    return true;
  }
  const mode = getOllamaEmulationMode();
  if (mode === 'off') {
    res.status(404).json({ error: 'Ollama emulation is disabled' });
    return false;
  }
  if (mode === 'open-loopback') {
    if (isLoopback(req)) return true;
    res.status(403).json({
      error: 'Ollama open-loopback mode only accepts connections from this machine',
    });
    return false;
  }
  const token = extractApiToken(req);
  if (!token || !timingSafeStringEqual(token, getUnifiedApiKey())) {
    res.status(401).json({ error: 'Invalid API key' });
    return false;
  }
  return true;
}

function ollamaModel(model: ReturnType<typeof buildModelListing>['models'][number]) {
  return {
    name: model.id,
    model: model.id,
    modified_at: new Date(0).toISOString(),
    size: 0,
    digest: '',
    details: {
      parent_model: '',
      format: 'freellmapi',
      family: model.ownedBy,
      families: [model.ownedBy],
      parameter_size: 'remote',
      quantization_level: 'remote',
    },
  };
}

ollamaRouter.get('/api/tags', (req, res) => {
  if (!authorize(req, res)) return;
  res.json({ models: buildModelListing().models.map(ollamaModel) });
});

ollamaRouter.get('/api/version', (req, res) => {
  if (!authorize(req, res)) return;
  res.json({ version: '0.9.9-freellmapi' });
});

const showSchema = z.object({ model: z.string().optional(), name: z.string().optional() }).passthrough();
ollamaRouter.post('/api/show', (req, res) => {
  if (!authorize(req, res)) return;
  const parsed = showSchema.safeParse(req.body);
  if (!parsed.success || !(parsed.data.model || parsed.data.name)) {
    res.status(400).json({ error: 'model is required' });
    return;
  }
  const id = parsed.data.model || parsed.data.name!;
  const model = buildModelListing().models.find(entry => entry.id === id);
  if (!model) {
    res.status(404).json({ error: `model '${id}' not found` });
    return;
  }
  res.json({
    license: '',
    modelfile: `FROM ${model.id}`,
    parameters: `num_ctx ${model.contextWindow ?? 128000}`,
    template: '{{ .Prompt }}',
    details: ollamaModel(model).details,
    model_info: {
      'general.architecture': model.ownedBy,
      'general.context_length': model.contextWindow ?? 128000,
    },
    capabilities: model.supportsTools
      ? ['completion', 'tools']
      : ['completion'],
  });
});

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.object({}).passthrough())]).optional(),
  tool_name: z.string().optional(),
  tool_calls: z.array(z.object({}).passthrough()).optional(),
}).passthrough();

const chatSchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  tools: z.array(z.object({}).passthrough()).optional(),
  options: z.object({}).passthrough().optional(),
  format: z.union([z.literal('json'), z.record(z.string(), z.unknown())]).optional(),
}).passthrough();

function ollamaMessages(raw: z.infer<typeof messageSchema>[]): ChatMessage[] {
  return raw.map((message, messageIndex) => ({
    role: message.role,
    content: message.content ?? '',
    ...(message.tool_name ? { name: message.tool_name } : {}),
    ...(message.role === 'tool'
      ? { tool_call_id: (message as any).tool_call_id ?? `call_${messageIndex}` }
      : {}),
    ...(message.tool_calls?.length
      ? {
        tool_calls: message.tool_calls
          .filter((call: any) => call?.function?.name)
          .map((call: any, callIndex) => ({
            id: call.id || `call_${messageIndex}_${callIndex}`,
            type: 'function' as const,
            function: {
              name: call.function.name,
              arguments: typeof call.function.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call.function.arguments ?? {}),
            },
          })),
      }
      : {}),
  })) as ChatMessage[];
}

function ollamaTools(raw: unknown[] | undefined): ChatToolDefinition[] | undefined {
  if (!raw?.length) return undefined;
  const tools = raw
    .filter((tool: any) => tool?.function?.name)
    .map((tool: any) => ({
      type: 'function' as const,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      },
    }));
  return tools.length ? tools : undefined;
}

function ollamaToolCalls(result: Pick<InboundChatResult, 'toolCalls'>) {
  return result.toolCalls.map(call => {
    let args: unknown = {};
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      args = { value: call.function.arguments };
    }
    return {
      function: {
        name: call.function.name,
        arguments: args,
      },
    };
  });
}

function ollamaWire(model: string): InboundChatWire {
  const createdAt = () => new Date().toISOString();
  return {
    sendError: (res, status, message) => res.status(status).json({ error: message }),
    sendNonStream: (res, result) => {
      res.json({
        model,
        created_at: createdAt(),
        message: {
          role: 'assistant',
          content: result.text,
          ...(result.reasoning ? { thinking: result.reasoning } : {}),
          ...(result.toolCalls.length ? { tool_calls: ollamaToolCalls(result) } : {}),
        },
        done: true,
        done_reason: result.finishReason ?? 'stop',
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: result.promptTokens,
        eval_count: result.completionTokens,
      });
    },
    startStream: (res) => {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-cache');
    },
    sendTextDelta: (res, _route, text) => {
      res.write(`${JSON.stringify({
        model,
        created_at: createdAt(),
        message: { role: 'assistant', content: text },
        done: false,
      })}\n`);
    },
    sendReasoningDelta: (res, _route, thinking) => {
      res.write(`${JSON.stringify({
        model,
        created_at: createdAt(),
        message: { role: 'assistant', content: '', thinking },
        done: false,
      })}\n`);
    },
    sendToolCalls: (res, _route, calls) => {
      res.write(`${JSON.stringify({
        model,
        created_at: createdAt(),
        message: {
          role: 'assistant',
          content: '',
          tool_calls: ollamaToolCalls({ toolCalls: calls }),
        },
        done: false,
      })}\n`);
    },
    finishStream: (res, result) => {
      res.write(`${JSON.stringify({
        model,
        created_at: createdAt(),
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: result.finishReason ?? 'stop',
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: result.promptTokens,
        eval_count: result.completionTokens,
      })}\n`);
      res.end();
    },
    sendStreamError: (res, message) => {
      res.write(`${JSON.stringify({ error: message, done: true })}\n`);
    },
  };
}

ollamaRouter.post('/api/chat', (req, res) => {
  if (!authorize(req, res)) return;
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: `invalid request: ${parsed.error.message}` });
    return;
  }
  const body = parsed.data;
  const options = body.options as Record<string, unknown> | undefined;
  const rawSession = req.headers['x-ollama-session-id'] ?? req.headers['x-session-id'];
  const sessionId = Array.isArray(rawSession) ? rawSession[0] : rawSession;
  void runInboundChat(req, res, {
    model: body.model || 'auto',
    messages: ollamaMessages(body.messages),
    stream: body.stream !== false,
    maxTokens: typeof options?.num_predict === 'number' ? options.num_predict : undefined,
    temperature: typeof options?.temperature === 'number' ? options.temperature : undefined,
    topP: typeof options?.top_p === 'number' ? options.top_p : undefined,
    topK: typeof options?.top_k === 'number' ? options.top_k : undefined,
    stop: Array.isArray(options?.stop)
      ? options.stop.filter((value): value is string => typeof value === 'string')
      : undefined,
    tools: ollamaTools(body.tools),
    responseFormat: body.format
      ? (body.format === 'json'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: 'ollama_response', schema: body.format } })
      : undefined,
    sessionId,
    endpoint: 'ollama/chat',
  }, ollamaWire(body.model || 'auto'));
});

const generateSchema = z.object({
  model: z.string().optional(),
  prompt: z.string().default(''),
  system: z.string().optional(),
  suffix: z.string().optional(),
  stream: z.boolean().optional(),
  options: z.object({}).passthrough().optional(),
  format: z.union([z.literal('json'), z.record(z.string(), z.unknown())]).optional(),
}).passthrough();

function generateWire(model: string): InboundChatWire {
  const wire = ollamaWire(model);
  return {
    ...wire,
    sendNonStream: (res, result) => {
      res.json({
        model,
        created_at: new Date().toISOString(),
        response: result.text,
        thinking: result.reasoning || undefined,
        done: true,
        done_reason: result.finishReason ?? 'stop',
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: result.promptTokens,
        eval_count: result.completionTokens,
      });
    },
    sendTextDelta: (res, _route, text) => {
      res.write(`${JSON.stringify({
        model,
        created_at: new Date().toISOString(),
        response: text,
        done: false,
      })}\n`);
    },
    sendReasoningDelta: (res, _route, thinking) => {
      res.write(`${JSON.stringify({
        model,
        created_at: new Date().toISOString(),
        response: '',
        thinking,
        done: false,
      })}\n`);
    },
  };
}

ollamaRouter.post('/api/generate', (req, res) => {
  if (!authorize(req, res)) return;
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: `invalid request: ${parsed.error.message}` });
    return;
  }
  const body = parsed.data;
  const options = body.options as Record<string, unknown> | undefined;
  const messages: ChatMessage[] = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
  messages.push({
    role: 'user',
    content: body.suffix
      ? `${body.prompt}\n\nComplete the text before this suffix:\n${body.suffix}`
      : body.prompt,
  });
  void runInboundChat(req, res, {
    model: body.model || 'auto',
    messages,
    stream: body.stream !== false,
    maxTokens: typeof options?.num_predict === 'number' ? options.num_predict : undefined,
    temperature: typeof options?.temperature === 'number' ? options.temperature : undefined,
    topP: typeof options?.top_p === 'number' ? options.top_p : undefined,
    topK: typeof options?.top_k === 'number' ? options.top_k : undefined,
    responseFormat: body.format
      ? (body.format === 'json'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: 'ollama_response', schema: body.format } })
      : undefined,
    endpoint: 'ollama/generate',
  }, generateWire(body.model || 'auto'));
});

const embedSchema = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]),
  dimensions: z.number().int().positive().optional(),
}).passthrough();

async function handleEmbed(req: Request, res: Response, legacy: boolean): Promise<void> {
  if (!authorize(req, res)) return;
  const parsed = embedSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: `invalid request: ${parsed.error.message}` });
    return;
  }
  const inputs = Array.isArray(parsed.data.input) ? parsed.data.input : [parsed.data.input];
  try {
    const result = await runEmbeddings(parsed.data.model, inputs, parsed.data.dimensions);
    if (legacy) {
      res.json({ embedding: result.vectors[0] ?? [] });
    } else {
      res.json({
        model: parsed.data.model || result.family,
        embeddings: result.vectors,
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: result.inputTokens,
      });
    }
  } catch (error: any) {
    const status = error instanceof EmbeddingsError ? error.status : 502;
    res.status(status).json({ error: error.message ?? 'embedding request failed' });
  }
}

ollamaRouter.post('/api/embed', (req, res) => {
  void handleEmbed(req, res, false);
});

// The dashboard already owns POST /api/embeddings. A valid dashboard session
// always falls through to that router; otherwise this exact path is Ollama's
// legacy embeddings endpoint and is governed by the emulation auth mode.
ollamaRouter.post('/api/embeddings', (req: Request, res: Response, next: NextFunction) => {
  const dashboardToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
  if (validateSession(dashboardToken)) {
    next();
    return;
  }
  void handleEmbed(req, res, true);
});
