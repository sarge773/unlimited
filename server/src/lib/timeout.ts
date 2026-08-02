// ── TimeoutError + withWatchdog utility ───────────────────────────────────
//
// The existing provider `fetchWithTimeout` (in providers/base.ts) already
// uses AbortController + setTimeout for a per-call deadline. This module
// surfaces that behavior as a reusable utility + a typed error so the proxy
// can classify timeouts vs transport errors cleanly (the old code matched
// on substring of "aborted" / "timeout" which was fragile).
//
// Usage:
//   import { withWatchdog, TimeoutError } from '../lib/timeout.js';
//   try {
//     const result = await withWatchdog(
//       () => provider.chatCompletion(...),
//       15000,
//     );
//   } catch (e) {
//     if (e instanceof TimeoutError) { /* retry/failover */ }
//     else { /* transport / API error */ }
//   }

export class TimeoutError extends Error {
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly cause?: unknown;

  constructor(timeoutMs: number, elapsedMs: number, cause?: unknown) {
    super(`watchdog fired after ${elapsedMs}ms (deadline ${timeoutMs}ms)`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
    this.cause = cause;
  }
}

/**
 * Run an async function with a hard deadline. If the function hasn't
 * settled by the deadline, aborts the underlying fetch (via AbortController)
 * and throws a TimeoutError. The wrapped function can opt into abort by
 * receiving an AbortSignal as a second arg — see base.ts's fetchWithTimeout
 * for the existing pattern.
 *
 * The error from the abort (DOMException name='AbortError') is caught and
 * re-thrown as TimeoutError so the caller can `instanceof` it. Any other
 * error from the inner function propagates untouched.
 */
export async function withWatchdog<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Set up the abort timer. We resolve to TimeoutError instead of letting
  // the AbortError escape so the proxy can `instanceof TimeoutError`.
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { controller.abort(); } catch { /* controller may already be settled */ }
      reject(new TimeoutError(timeoutMs, Date.now() - t0));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fn(controller.signal),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Heuristic classifier: is this error a timeout (vs a transport/API error)?
 * Used by the proxy to decide whether to bump the per-platform breaker
 * (transient transport errors count toward the breaker; explicit
 * provider-side 4xx like 401/403 do not).
 */
export function isTimeoutError(err: unknown): err is TimeoutError {
  if (err instanceof TimeoutError) return true;
  if (!(err instanceof Error)) return false;
  const name = (err as any).name || '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  // node fetch uses DOMException with name='AbortError' when the signal aborts;
  // also catch ETIMEDOUT-style messages from undici.
  const msg = err.message || '';
  return /timeout|etimedout|aborted/i.test(msg);
}
