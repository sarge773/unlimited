import type {
  ChatContentBlock,
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import type { ReasoningEffort, ResponseFormat } from './sampling-params.js';
import type { InboundChatResult } from './inbound-chat.js';

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name?: string; response?: unknown };
  thoughtSignature?: string;
  [key: string]: unknown;
}

export interface GeminiContent {
  role?: 'user' | 'model';
  parts?: GeminiPart[];
}

export interface GeminiInboundRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts?: GeminiPart[] };
  tools?: Array<{ functionDeclarations?: Array<{
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }> }>;
  toolConfig?: {
    functionCallingConfig?: {
      mode?: string;
      allowedFunctionNames?: string[];
    };
  };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseMimeType?: string;
    responseSchema?: Record<string, unknown>;
    thinkingConfig?: { thinkingBudget?: number };
  };
}

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment',
  'definitions',
  'exclusiveMinimum', 'exclusiveMaximum',
  'patternProperties', 'unevaluatedProperties', 'unevaluatedItems',
  'if', 'then', 'else',
  'contentEncoding', 'contentMediaType', 'contentSchema',
  'dependentRequired', 'dependentSchemas', 'dependencies',
  'additionalProperties',
  'examples', 'const', 'readOnly', 'writeOnly',
  'uniqueItems',
  'not', 'allOf', 'oneOf',
  'prefixItems',
  'contains', 'minContains', 'maxContains',
  'propertyNames',
  'multipleOf',
  'deprecated',
]);

const VENDOR_EXTENSION_SCHEMA_KEY = /^x-/i;

export function sanitizeForGemini(schema: unknown): unknown {
  return sanitizeSchema(schema, false);
}

function sanitizeSchema(schema: unknown, insidePropertiesMap: boolean): unknown {
  if (Array.isArray(schema)) return schema.map(value => sanitizeSchema(value, false));
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (insidePropertiesMap) {
      out[key] = sanitizeSchema(value, false);
    } else if (!UNSUPPORTED_SCHEMA_KEYS.has(key) && !VENDOR_EXTENSION_SCHEMA_KEY.test(key)) {
      out[key] = sanitizeSchema(value, key === 'properties');
    }
  }
  return out;
}

function serializeResponse(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

function systemText(system?: GeminiInboundRequest['systemInstruction']): string {
  return (system?.parts ?? [])
    .map(part => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

export function geminiContentsToMessages(body: GeminiInboundRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const lastCallIdByName = new Map<string, string>();
  const system = systemText(body.systemInstruction);
  if (system) messages.push({ role: 'system', content: system });

  for (const content of body.contents ?? []) {
    const role = content.role === 'model' ? 'assistant' : 'user';
    const textBlocks: ChatContentBlock[] = [];
    const calls: ChatToolCall[] = [];
    const functionResponses: GeminiPart[] = [];

    for (const part of content.parts ?? []) {
      if (typeof part.text === 'string') textBlocks.push({ type: 'text', text: part.text });
      const inline = part.inlineData ?? (
        part.inline_data
          ? { mimeType: part.inline_data.mime_type, data: part.inline_data.data }
          : undefined
      );
      if (inline?.mimeType && inline.data) {
        textBlocks.push({
          type: 'image_url',
          image_url: { url: `data:${inline.mimeType};base64,${inline.data}` },
        });
      }
      if (part.functionCall?.name) {
        const id = part.functionCall.id || `call_${messages.length}_${calls.length}`;
        calls.push({
          id,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: typeof part.functionCall.args === 'string'
              ? part.functionCall.args
              : JSON.stringify(part.functionCall.args ?? {}),
          },
          ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}),
        });
        lastCallIdByName.set(part.functionCall.name, id);
      }
      if (part.functionResponse?.name) functionResponses.push(part);
    }

    if (role === 'assistant') {
      messages.push({
        role,
        content: textBlocks.length ? textBlocks : null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
    } else if (textBlocks.length || functionResponses.length === 0) {
      messages.push({
        role: 'user',
        content: textBlocks.length ? textBlocks : '',
      });
    }

    for (const part of functionResponses) {
      const response = part.functionResponse!;
      messages.push({
        role: 'tool',
        tool_call_id: response.id || lastCallIdByName.get(response.name!)
          || `call_${messages.length}`,
        name: response.name,
        content: serializeResponse(response.response),
      });
    }
  }
  return messages;
}

export function geminiToolsToChatTools(
  tools: GeminiInboundRequest['tools'],
): ChatToolDefinition[] | undefined {
  const declarations = (tools ?? []).flatMap(tool => tool.functionDeclarations ?? []);
  const converted = declarations
    .filter(declaration => !!declaration.name)
    .map(declaration => ({
      type: 'function' as const,
      function: {
        name: declaration.name!,
        description: declaration.description,
        parameters: declaration.parameters ?? { type: 'object', properties: {} },
      },
    }));
  return converted.length ? converted : undefined;
}

export function geminiToolChoice(config: GeminiInboundRequest['toolConfig']): ChatToolChoice | undefined {
  const fc = config?.functionCallingConfig;
  const mode = fc?.mode?.toUpperCase();
  if (!mode || mode === 'AUTO') return 'auto';
  if (mode === 'NONE') return 'none';
  if (mode === 'ANY') {
    const name = fc?.allowedFunctionNames?.[0];
    return name ? { type: 'function', function: { name } } : 'required';
  }
  return undefined;
}

export function geminiResponseFormat(
  config: GeminiInboundRequest['generationConfig'],
): ResponseFormat | undefined {
  if (config?.responseMimeType !== 'application/json') return undefined;
  if (config.responseSchema) {
    return {
      type: 'json_schema',
      json_schema: {
        name: 'gemini_response',
        schema: config.responseSchema,
      },
    };
  }
  return { type: 'json_object' };
}

export function effortFromGeminiThinking(
  config: GeminiInboundRequest['generationConfig'],
): ReasoningEffort | undefined {
  const budget = config?.thinkingConfig?.thinkingBudget;
  if (budget == null) return undefined;
  if (budget <= 0) return 'none';
  if (budget < 4096) return 'low';
  if (budget < 16384) return 'medium';
  return 'high';
}

export function geminiFinishReason(
  finishReason: string | null,
  hasToolCalls = false,
): string {
  if (hasToolCalls) return 'STOP';
  switch ((finishReason ?? '').toLowerCase()) {
    case 'length':
      return 'MAX_TOKENS';
    case 'content_filter':
      return 'SAFETY';
    default:
      return 'STOP';
  }
}

export function geminiPartsFromResult(result: Pick<InboundChatResult, 'text' | 'reasoning' | 'toolCalls'>): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (result.reasoning) parts.push({ text: result.reasoning, thought: true });
  if (result.text) parts.push({ text: result.text });
  for (const call of result.toolCalls) {
    let args: unknown = {};
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      args = { value: call.function.arguments };
    }
    parts.push({
      functionCall: {
        id: call.id,
        name: call.function.name,
        args,
      },
      ...(call.thought_signature ? { thoughtSignature: call.thought_signature } : {}),
    });
  }
  return parts;
}

export function geminiResponseFromResult(result: InboundChatResult): Record<string, unknown> {
  return {
    candidates: [{
      content: { role: 'model', parts: geminiPartsFromResult(result) },
      finishReason: geminiFinishReason(result.finishReason, result.toolCalls.length > 0),
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: result.promptTokens,
      candidatesTokenCount: result.completionTokens,
      totalTokenCount: result.promptTokens + result.completionTokens,
    },
    modelVersion: result.route.modelId,
  };
}

export function estimateGeminiTokens(body: Pick<GeminiInboundRequest, 'contents' | 'systemInstruction'>): number {
  const messages = geminiContentsToMessages({
    contents: body.contents,
    systemInstruction: body.systemInstruction,
  });
  return messages.reduce((sum, message) => {
    const text = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content ?? '');
    return sum + Math.ceil(text.length / 4);
  }, 0);
}
