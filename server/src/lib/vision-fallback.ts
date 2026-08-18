import type { ChatMessage } from '@freellmapi/shared/types.js';

/**
 * Capability-aware vision fallback (#811, multimodal slice of #843).
 *
 * When a request carries image blocks but the routed target model can't see
 * them, the gateway may run a vision-capable pre-analysis (Qwen VL) and
 * REPLACE the image blocks with the resulting text summary — so the target
 * model never receives image blocks (image-removal semantics). This module
 * holds the pure, dependency-free mechanics; the analyzer itself is injected
 * so tests can pass a stub and the proxy wires in the real Qwen VL call.
 */

export interface ExtractedImage {
  /** Index of the message carrying this block. */
  messageIndex: number;
  /** Index of the block within that message's content array. */
  blockIndex: number;
  /** The `image_url.url` for OpenAI-style blocks; undefined for bare `image`. */
  url?: string;
  /** The raw block object (for inspection/removal bookkeeping). */
  block: Record<string, unknown>;
}

function isImageBlock(block: unknown): block is Record<string, unknown> {
  if (!block || typeof block !== 'object') return false;
  const type = (block as { type?: unknown })?.type;
  return type === 'image_url' || type === 'image';
}

/** Collect every image block in the message list, in order. */
export function extractImageBlocks(messages: ChatMessage[]): ExtractedImage[] {
  const out: ExtractedImage[] = [];
  messages.forEach((m, messageIndex) => {
    if (!Array.isArray(m.content)) return;
    m.content.forEach((block, blockIndex) => {
      if (!isImageBlock(block)) return;
      const url = typeof block.image_url === 'object' && block.image_url !== null
        && typeof (block.image_url as { url?: unknown })?.url === 'string'
        ? (block.image_url as { url: string }).url
        : undefined;
      out.push({ messageIndex, blockIndex, url, block });
    });
  });
  return out;
}

/** True when the request has at least one image AND the target can't see it —
 *  the condition that triggers vision fallback. */
export function visionFallbackNeeded(hasImage: boolean, targetSupportsVision: boolean): boolean {
  return hasImage && !targetSupportsVision;
}

export interface StripOptions {
  /** Text to substitute for the removed images. When empty, the images are
   *  dropped entirely (removal semantics without an analysis). */
  summary?: string;
}

/**
 * Return a NEW message list with every image block replaced by a single text
 * block (the injected summary). The original messages are untouched. When the
 * summary is empty, image blocks are removed outright — the target model never
 * sees them either way. Non-image blocks pass through byte-for-byte.
 */
export function stripImagesToText(messages: ChatMessage[], opts: StripOptions = {}): ChatMessage[] {
  const summary = opts.summary;
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const hasImages = m.content.some(isImageBlock);
    if (!hasImages) return m;
    const nextContent = m.content.filter((block) => !isImageBlock(block));
    if (summary !== undefined && summary !== '') {
      nextContent.push({ type: 'text', text: summary });
    }
    return { ...m, content: nextContent };
  });
}

/** Shape accepted by the injected analyzer: images → one summary string. */
export type ImageAnalyzer = (images: ExtractedImage[]) => Promise<string | null>;

/**
 * Full fallback flow: extract images, run the analyzer, and produce the
 * stripped message list. Returns null when the analyzer fails (caller decides
 * whether to fall through to the original messages or reject).
 */
export async function applyVisionFallback(
  messages: ChatMessage[],
  analyze: ImageAnalyzer,
): Promise<{ messages: ChatMessage[]; summary: string | null } | null> {
  const images = extractImageBlocks(messages);
  if (images.length === 0) return null;
  const summary = await analyze(images);
  if (summary === null || summary === '') return null;
  return { messages: stripImagesToText(messages, { summary }), summary };
}

/** Default Qwen VL analyzer: an OpenAI-compatible chat-completions call against
 *  the configured vision endpoint. Injectable for tests. The endpoint is
 *  configured via VISION_FALLBACK_BASE_URL / VISION_FALLBACK_API_KEY /
 *  VISION_FALLBACK_MODEL (default qwen2.5-vl-72b-instruct); returns null when
 *  unconfigured so callers fall through to the normal rejection. */
export async function analyzeWithQwenVL(
  images: ExtractedImage[],
  opts: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<string | null> {
  const baseUrl = opts.baseUrl ?? process.env.VISION_FALLBACK_BASE_URL;
  const apiKey = opts.apiKey ?? process.env.VISION_FALLBACK_API_KEY;
  const model = opts.model ?? process.env.VISION_FALLBACK_MODEL ?? 'qwen2.5-vl-72b-instruct';
  if (!baseUrl) return null;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  const imageBlocks = images
    .filter(i => i.url !== undefined)
    .map(i => ({ type: 'image_url', image_url: { url: i.url! } }));
  if (imageBlocks.length === 0) return null;

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          ...imageBlocks,
          { type: 'text', text: 'Describe the image(s) concisely in plain text, including any text, numbers, or UI elements visible. The summary will be sent to a text-only model in place of the images.' },
        ],
      },
    ],
    max_tokens: 300,
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) return null;
    const data = await res.json() as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    return content && content.trim() !== '' ? content.trim() : null;
  } catch {
    return null;
  }
}

/** One-shot convenience: try the vision fallback with the default Qwen VL
 *  analyzer; null when unconfigured or the analysis fails. */
export function tryVisionFallback(
  messages: ChatMessage[],
  opts: Parameters<typeof analyzeWithQwenVL>[1] = {},
): Promise<{ messages: ChatMessage[]; summary: string | null } | null> {
  return applyVisionFallback(messages, images => analyzeWithQwenVL(images, opts));
}
