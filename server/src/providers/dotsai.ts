import { OpenAICompatProvider } from './openai-compat.js';

/**
 * Dots AI provider (OpenAI-compatible).
 * Docs: https://dots.ai/platform/docs
 *
 * Note: The official docs example endpoint is
 * `https://note3-prev-api.askdiandian.com/v1`, and authentication uses an
 * `api-key` header (not Bearer). See
 * https://chaihongjun.me/others/59.html and the official docs for details.
 */
export class DotsAIProvider extends OpenAICompatProvider {
  constructor(opts: { baseUrl?: string; timeoutMs?: number; keyless?: boolean } = {}) {
    super({
      platform: 'dots-ai',
      name: 'Dots AI',
      baseUrl: opts.baseUrl ?? 'https://note3-prev-api.askdiandian.com/v1',
      timeoutMs: opts.timeoutMs,
      keyless: opts.keyless,
    });
  }

  /** Dots AI uses an `api-key` header instead of Bearer auth.
   * See https://dots.ai/platform/docs "认证与请求头". */
  protected authHeader(apiKey: string): Record<string, string> {
    return this.keyless ? {} : { 'api-key': apiKey };
  }
}
