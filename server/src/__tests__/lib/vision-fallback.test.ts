import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import {
  extractImageBlocks,
  visionFallbackNeeded,
  stripImagesToText,
  applyVisionFallback,
  analyzeWithQwenVL,
  tryVisionFallback,
  type ExtractedImage,
} from '../../lib/vision-fallback.js';

// #811 capability-aware vision fallback: image requests route to a
// vision-capable model when one exists (pass-through), and when the gateway
// has no vision model the Qwen VL pre-analysis replaces image blocks with a
// text summary BEFORE the no-vision rejection — the target model never
// receives image blocks. Failure or unconfigured analyzer falls through to
// the existing rejection.

function msg(role: 'user' | 'assistant' | 'system', content: unknown): ChatMessage {
  return { role, content } as ChatMessage;
}

const textOnly = [msg('user', 'hello')];

const withImage: ChatMessage[] = [
  msg('system', 'sys'),
  msg('user', [
    { type: 'text', text: 'what is in this image?' },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
  ]),
];

const bareImage: ChatMessage[] = [
  msg('user', [
    { type: 'image', data: 'base64data' },
  ]),
];

describe('vision-fallback: extraction', () => {
  it('extracts image_url and bare image blocks in order', () => {
    const imgs = extractImageBlocks(withImage);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.url).toBe('https://example.com/a.png');
    expect(imgs[0]!.messageIndex).toBe(1);
    expect(imgs[0]!.blockIndex).toBe(1);

    const bare = extractImageBlocks(bareImage);
    expect(bare).toHaveLength(1);
    expect(bare[0]!.url).toBeUndefined();
  });

  it('returns [] for text-only messages', () => {
    expect(extractImageBlocks(textOnly)).toEqual([]);
  });
});

describe('vision-fallback: need detection (pass-through)', () => {
  it('vision-capable target + image → no fallback (pass-through)', () => {
    expect(visionFallbackNeeded(true, true)).toBe(false);
  });

  it('text-only request → no fallback regardless of target', () => {
    expect(visionFallbackNeeded(false, false)).toBe(false);
    expect(visionFallbackNeeded(false, true)).toBe(false);
  });

  it('image + non-visual target → fallback needed', () => {
    expect(visionFallbackNeeded(true, false)).toBe(true);
  });
});

describe('vision-fallback: image removal (stripImagesToText)', () => {
  it('replaces image blocks with the summary text (removal semantics)', () => {
    const out = stripImagesToText(withImage, { summary: '[A red circle]' });
    // The original messages are untouched.
    expect(extractImageBlocks(withImage)).toHaveLength(1);
    // The new list has no image blocks anywhere.
    expect(extractImageBlocks(out)).toHaveLength(0);
    // Text blocks survive; the summary text is appended to the user message.
    const user = out.find(m => m.role === 'user');
    expect(Array.isArray(user!.content)).toBe(true);
    const content = user!.content as unknown[];
    expect(content.some(b => (b as { type?: string }).type === 'image_url')).toBe(false);
    expect(content.some(b => (b as { type?: string }).type === 'text' && (b as { text?: string }).text === '[A red circle]')).toBe(true);
  });

  it('removes image blocks outright when no summary is given', () => {
    const out = stripImagesToText(bareImage);
    expect(extractImageBlocks(out)).toHaveLength(0);
    const user = out.find(m => m.role === 'user');
    expect(user!.content).toEqual([]);
  });

  it('leaves text-only messages byte-for-byte identical', () => {
    const out = stripImagesToText(textOnly, { summary: 'x' });
    expect(out).toEqual(textOnly);
  });
});

describe('vision-fallback: applyVisionFallback', () => {
  it('returns null when the analyzer fails (failure path)', async () => {
    const analyzer = async () => null;
    const out = await applyVisionFallback(withImage, analyzer);
    expect(out).toBeNull();
  });

  it('returns null when there are no images', async () => {
    const analyzer = async () => 'summary';
    const out = await applyVisionFallback(textOnly, analyzer);
    expect(out).toBeNull();
  });

  it('returns stripped messages with the summary on success', async () => {
    const analyzer = async (_imgs: ExtractedImage[]) => 'the image shows a chart';
    const out = await applyVisionFallback(withImage, analyzer);
    expect(out).not.toBeNull();
    expect(out!.summary).toBe('the image shows a chart');
    expect(extractImageBlocks(out!.messages)).toHaveLength(0);
  });
});

describe('vision-fallback: Qwen VL analyzer', () => {
  it('returns null when unconfigured (no base URL)', async () => {
    const out = await analyzeWithQwenVL(extractImageBlocks(withImage), { baseUrl: undefined });
    expect(out).toBeNull();
  });

  it('calls the OpenAI-compatible endpoint and returns the content', async () => {
    const fetchImpl = async (url: string, init: RequestInit) => {
      expect(url).toBe('https://vl.example/chat/completions');
      const body = JSON.parse(String(init.body)) as { model: string; messages: { content: unknown[] }[] };
      expect(body.model).toBe('qwen2.5-vl-72b-instruct');
      const content = body.messages[0]!.content as { type: string }[];
      expect(content.some(b => b.type === 'image_url')).toBe(true);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'a red circle on white' } }] }),
      } as unknown as Response;
    };
    const out = await analyzeWithQwenVL(extractImageBlocks(withImage), {
      baseUrl: 'https://vl.example',
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(out).toBe('a red circle on white');
  });

  it('returns null on non-ok or empty content', async () => {
    const fail = async () => ({ ok: false, json: async () => ({}) }) as unknown as Response;
    expect(await analyzeWithQwenVL(extractImageBlocks(withImage), { baseUrl: 'https://vl.example', fetchImpl: fail as typeof fetch })).toBeNull();

    const empty = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '   ' } }] }) }) as unknown as Response;
    expect(await analyzeWithQwenVL(extractImageBlocks(withImage), { baseUrl: 'https://vl.example', fetchImpl: empty as typeof fetch })).toBeNull();
  });

  it('tryVisionFallback one-shot: null when analyzer fails', async () => {
    const fetchImpl = async () => ({ ok: false, json: async () => ({}) }) as unknown as Response;
    const out = await tryVisionFallback(withImage, { baseUrl: 'https://vl.example', fetchImpl: fetchImpl as typeof fetch });
    expect(out).toBeNull();
  });
});
