import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { classifyClientAgent, type ClientAgent } from './client-classifier.js';

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
  agent: ClientAgent | null;
  /**
   * Provider-reported request size from a 4xx error on a prior attempt in
   * this same request. Set by recordRetryableFailure in lib/fallback-loop.ts
   * when a provider names the real token count in its error body (Groq,
   * OpenRouter, Cloudflare). Consumed by selectKeyForModel in services/router.ts
   * to skip subsequent models whose TPM ceiling is below this number, so a
   * single first 413 saves every downstream doomed attempt.
   * null = no provider has reported a real size yet; the local estimator is
   * in charge. Never decreases — once observed, the larger value sticks so
   * an early small-size report can't under-skip a later larger request.
   */
  observedRequestTokens: number | null;
}

// Request-scoped caller identity, readable from anywhere below the middleware
// without threading parameters through every logRequest() call site (the chat
// proxy, responses, anthropic, fusion, embeddings and media paths all log).
// `observedRequestTokens` rides the same store so the fallback loop can write
// it once per request and the router can read it on every iteration without
// extending any function signatures.
const storage = new AsyncLocalStorage<ClientContext>();

// Resolve the client IP from the socket peer address. The X-Forwarded-For
// header is only trusted when Express's "trust proxy" setting is enabled
// (opt-in via app.set('trust proxy', ...) or the TRUST_PROXY env var in
// run.ts). Without that, a spoofed header from a LAN client is ignored.
function resolveClientIp(req: Request): string | null {
  const trustProxy = req.app?.get('trust proxy') ?? false;
  let raw: string | null;
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    raw = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
  } else {
    raw = req.socket.remoteAddress || null;
  }
  // Normalize IPv4-mapped IPv6 ("::ffff:192.168.0.5" -> "192.168.0.5").
  return raw?.replace(/^::ffff:/i, '') ?? null;
}

// Privacy opt-out: REQUEST_ANALYTICS_LOG_CLIENT=false stores nulls instead of
// the caller's IP/UA. Read per request (not at module load) so tests and
// embedders can toggle it without re-importing.
function clientLoggingEnabled(): boolean {
  return process.env.REQUEST_ANALYTICS_LOG_CLIENT !== 'false';
}

export function clientContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!clientLoggingEnabled()) {
    storage.run({ ip: null, userAgent: null, agent: null, observedRequestTokens: null }, next);
    return;
  }
  const ua = req.headers['user-agent'];
  storage.run({
    ip: resolveClientIp(req),
    userAgent: typeof ua === 'string' ? ua.slice(0, 256) : null,
    agent: classifyClientAgent(req),
    observedRequestTokens: null,
  }, next);
}

export function getClientContext(): ClientContext {
  return storage.getStore() ?? { ip: null, userAgent: null, agent: null, observedRequestTokens: null };
}

/**
 * Record a provider-reported request size on the current request's context.
 * Called by lib/fallback-loop.ts when an upstream 4xx names the real token
 * count in its error body. Sticky: once set, the larger value wins so an
 * early small-size report can't under-skip a later larger request. Reads
 * from the AsyncLocalStorage store so the caller doesn't need to thread
 * the value through every layer.
 */
export function setObservedRequestTokens(tokens: number): void {
  const ctx = storage.getStore();
  if (!ctx) return;          // not in a request context — ignore (tests, startup)
  ctx.observedRequestTokens = Math.max(ctx.observedRequestTokens ?? 0, tokens);
}

/** Current sticky observed request size, or null when no provider has reported one. */
export function getObservedRequestTokens(): number | null {
  return storage.getStore()?.observedRequestTokens ?? null;
}
