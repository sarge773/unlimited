import { getDb } from '../db/index.js';
import { decrypt } from './crypto.js';
import { getProvider } from '../providers/index.js';
import { contentHasImage } from './content.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

/**
 * #812: capability-aware multimodal fallback.
 *
 * A user may pin a NON-visual coding model (e.g. DeepSeek V4 Flash) and still
 * send an image: routing that request to a vision model would break the pin,
 * and sending the image blocks to the non-visual model would either 400 or be
 * silently dropped. Instead we run a Qwen VL pre-analysis on the image, then
 * forward ONLY the resulting text to the originally requested model — the
 * target call never receives image blocks (acceptance criteria #3/#4).
 *
 * The Qwen VL model is the curated opencode/qwen-vl-plus-free entry seeded by
 * migration 20260811_000001_opencode_multimodal_curation. Requires an opencode
 * API key to be configured; without one the request is left untouched and the
 * caller keeps its existing no-vision handling.
 */

const QWEN_VL_PLATFORM = 'opencode';
const QWEN_VL_MODEL = 'qwen-vl-plus-free';
const IMAGE_ANALYSIS_SYSTEM_PROMPT =
  'Describe the image(s) in this message in detail: what is depicted, any text/UI elements, ' +
  'and anything relevant to a coding or data-analysis task. Output plain text only.';

/** Extract the first image URL from the last user message (best-effort). */
function firstImageUrl(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; image_url?: unknown };
      if (b.type !== 'image_url' && b.type !== 'image') continue;
      if (typeof b.image_url === 'string') return b.image_url;
      if (b.image_url && typeof b.image_url === 'object') {
        const url = (b.image_url as { url?: unknown }).url;
        if (typeof url === 'string') return url;
      }
    }
  }
  return null;
}

/** The decrypted opencode key, or null when none is configured. */
function opencodeKey(): string | null {
  const row = getDb().prepare(
    "SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') LIMIT 1",
  ).get(QWEN_VL_PLATFORM) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
  if (!row) return null;
  try {
    return decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    return null;
  }
}

/**
 * Pre-analyze images in `messages` with Qwen VL and return messages with the
 * image blocks replaced by the analysis text. Returns the original messages
 * unchanged when there is no image, no Qwen VL key, or the analysis fails —
 * the caller keeps its existing behaviour (e.g. no-vision error) in those
 * cases.
 */
export async function fallbackAnalyzeImages(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const hasImage = messages.some(m => contentHasImage(m.content));
  if (!hasImage) return messages;

  const imageUrl = firstImageUrl(messages);
  const key = opencodeKey();
  if (!imageUrl || !key) return messages;

  const provider = getProvider(QWEN_VL_PLATFORM);
  if (!provider) return messages;

  const analysisMessages: ChatMessage[] = [
    { role: 'system', content: IMAGE_ANALYSIS_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Analyze the following image:' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    },
  ];

  try {
    const result = await provider.chatCompletion(key, analysisMessages, QWEN_VL_MODEL);
    const analysis = result.choices?.[0]?.message?.content;
    if (!analysis || typeof analysis !== 'string' || !analysis.trim()) return messages;

    // Replace the image-bearing message's content with a text block carrying
    // the analysis; strip every image block so the target call is text-only.
    return messages.map(m => {
      if (!Array.isArray(m.content) || !contentHasImage(m.content)) return m;
      return {
        ...m,
        content: [{ type: 'text', text: `[Image analysis: ${analysis.trim()}]` }],
      };
    });
  } catch {
    return messages;
  }
}
