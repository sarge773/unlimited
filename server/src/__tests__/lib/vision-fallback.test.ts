import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fallbackAnalyzeImages } from '../../lib/vision-fallback.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

// #813: multimodal gateway tests — text pass-through, visual pass-through
// (no image → unchanged), non-visual fallback (Qwen VL analysis replaces the
// image blocks), fallback failure (keeps original messages), and image
// removal (the target call never receives image blocks).

// These are referenced inside the vi.mock factories, so they must be declared
// before the mocks (vitest hoists vi.mock above the imports; the factories run
// at import time, by which point these are initialized).
const mockKeyRow: { encrypted_key: string; iv: string; auth_tag: string } = {
  encrypted_key: 'enc', iv: 'iv', auth_tag: 'tag',
};
let mockAnalysis: string | null = 'a detailed description of the image';

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(() => ({
    prepare: () => ({ get: () => mockKeyRow }),
  })),
}));

vi.mock('../../lib/crypto.js', () => ({
  decrypt: vi.fn(() => 'opencode-key'),
}));

vi.mock('../../providers/index.js', () => ({
  getProvider: vi.fn(() => ({
    chatCompletion: async () => ({
      choices: [{ message: { content: mockAnalysis } }],
    }),
  })),
}));

import { getDb } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
import { getProvider } from '../../providers/index.js';

beforeEach(() => {
  mockAnalysis = 'a detailed description of the image';
});

afterEach(() => {
  // Reset call records AND the mockReturnValueOnce queue — a test that sets a
  // once-value without consuming it (the text-only case) would otherwise leak
  // it into the next test's first getProvider call.
  vi.resetAllMocks();
  // Restore the module factory's default implementations after resetAllMocks
  // wiped them.
  vi.mocked(getDb).mockImplementation(() => ({
    prepare: () => ({ get: () => mockKeyRow }),
  }));
  vi.mocked(decrypt).mockImplementation(() => 'opencode-key');
  vi.mocked(getProvider).mockImplementation(() => ({
    chatCompletion: async () => ({
      choices: [{ message: { content: mockAnalysis } }],
    }),
  }));
});

function imageMessage(): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ],
  };
}

describe('fallbackAnalyzeImages (#812/#813)', () => {
  it('passes text-only messages through unchanged', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const out = await fallbackAnalyzeImages(messages);
    expect(out).toBe(messages); // same reference = untouched
  });

  it('replaces image blocks with the analysis text (image removal)', async () => {
    const out = await fallbackAnalyzeImages([imageMessage()]);
    expect(out).not.toBeNull();
    expect(out[0].content).toEqual([
      { type: 'text', text: '[Image analysis: a detailed description of the image]' },
    ]);
    // No image_url block survives — the target call is text-only.
    const text = JSON.stringify(out[0].content);
    expect(text).not.toContain('image_url');
    expect(text).not.toContain('image/png');
  });

  it('keeps the original messages when the provider is absent', async () => {
    vi.mocked(getProvider).mockReturnValueOnce(undefined as never);
    const out = await fallbackAnalyzeImages([imageMessage()]);
    expect(out).toEqual([imageMessage()]);
  });

  it('keeps the original messages when the analysis fails', async () => {
    mockAnalysis = null; // provider returns an empty/missing content
    const out = await fallbackAnalyzeImages([imageMessage()]);
    expect(out).toEqual([imageMessage()]);
  });

  it('keeps the original messages when no opencode key is configured', async () => {
    vi.mocked(getDb).mockReturnValueOnce({
      prepare: () => ({ get: () => undefined }),
    } as never);
    const out = await fallbackAnalyzeImages([imageMessage()]);
    expect(out).toEqual([imageMessage()]);
  });

  it('does not call the provider for text-only messages', async () => {
    const spy = vi.fn();
    vi.mocked(getProvider).mockReturnValueOnce({ chatCompletion: spy } as never);
    await fallbackAnalyzeImages([{ role: 'user', content: 'plain text' }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('uses the decrypted opencode key and Qwen VL model', async () => {
    const spy = vi.fn(async () => ({
      choices: [{ message: { content: 'ok' } }],
    }));
    vi.mocked(getProvider).mockReturnValueOnce({ chatCompletion: spy } as never);
    await fallbackAnalyzeImages([imageMessage()]);
    expect(spy).toHaveBeenCalledWith('opencode-key', expect.any(Array), 'qwen-vl-plus-free');
    expect(decrypt).toHaveBeenCalledWith('enc', 'iv', 'tag');
  });
});
