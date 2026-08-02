// ── Per-platform circuit breaker ───────────────────────────────────────────
//
// The router has a per-model 429 penalty (services/router.ts) that demotes a
// single model in the chain. This module adds the *platform-level* layer:
// when 3+ consecutive requests to a platform fail (timeout / 5xx / transport
// error) within a 60s window, the breaker for that platform OPENS and ALL
// models on it are skipped for the cooldown. After 120s, the breaker enters
// HALF-OPEN: the next request probes, success closes the breaker, another
// failure re-opens it.
//
// State is persisted to the `settings` table (key=`breaker:<platform>`,
// value=JSON snapshot) so restarts don't reset the breaker mid-incident —
// a freshly-restarted freellmapi should still avoid a provider that was
// failing 30s before the crash. Read-then-write is a small race window
// but it's the same window the in-memory state already has, and the
// cost of a true distributed lock is not worth it for a single-user tool.
//
// Tunable via env (defaults match the user's design):
//   FALLBACK_BREAKER_FAIL_THRESHOLD   = 3  (consecutive failures to open)
//   FALLBACK_BREAKER_COOLDOWN_MS      = 120000  (open → half-open after this)
//   FALLBACK_BREAKER_FAIL_WINDOW_MS   = 60000  (failures must be within this)

import { getDb } from '../db/index.js';
import type { Platform } from '@freellmapi/shared/types.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerSnapshot {
  state: BreakerState;
  failCount: number;        // consecutive failures within the fail window
  lastFailAt: number;       // ms timestamp
  openedAt?: number;        // ms timestamp when the breaker last transitioned to open
  // Roll-up counters for the dashboard / ring buffer. Lightweight; safe
  // to keep growing.
  totalFailures: number;    // since process start
  totalSuccesses: number;   // since process start
  totalOpens: number;       // since process start
  // Exponential backoff on repeated opens: tracks how many times this
  // platform has re-opened (in quick succession) so we can delay the
  // next half-open probe. Resets to 0 on successful recovery.
  consecutiveOpens: number; // incremented each time breaker re-opens from half-open
  nextProbeAt?: number;     // do not transition to half-open before this timestamp (ms)
}

const KEY_PREFIX = 'breaker:';

class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly failWindowMs: number;
  // In-memory cache. Loaded lazily from the settings table on first access
  // to that platform; subsequent reads/writes hit the cache. The cache is
  // invalidated by every write to the settings table that we make.
  private readonly cache: Map<Platform, BreakerSnapshot> = new Map();

  constructor(opts?: { threshold?: number; cooldownMs?: number; failWindowMs?: number }) {
    this.threshold = opts?.threshold ?? parseInt(process.env.FALLBACK_BREAKER_FAIL_THRESHOLD ?? '3', 10);
    this.cooldownMs = opts?.cooldownMs ?? parseInt(process.env.FALLBACK_BREAKER_COOLDOWN_MS ?? '120000', 10);
    this.failWindowMs = opts?.failWindowMs ?? 60000;
  }

  private key(platform: Platform): string { return `${KEY_PREFIX}${platform}`; }

  private load(platform: Platform): BreakerSnapshot {
    const cached = this.cache.get(platform);
    if (cached) return cached;
    try {
      const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(this.key(platform)) as { value: string } | undefined;
      if (row) {
        const parsed = JSON.parse(row.value) as BreakerSnapshot;
        if (parsed && typeof parsed === 'object' && 'state' in parsed) {
          this.cache.set(platform, parsed);
          return parsed;
        }
      }
    } catch { /* corrupt row — fall through to default */ }
    const fresh: BreakerSnapshot = {
      state: 'closed',
      failCount: 0,
      lastFailAt: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      totalOpens: 0,
      consecutiveOpens: 0,
    };
    this.cache.set(platform, fresh);
    return fresh;
  }

  private save(platform: Platform, snap: BreakerSnapshot): void {
    this.cache.set(platform, snap);
    try {
      getDb().prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(this.key(platform), JSON.stringify(snap));
    } catch (e) {
      // Persist is best-effort; the in-memory cache is still authoritative
      // for the running process. Log + continue.
      console.warn(`[breaker] failed to persist ${platform} state: ${(e as Error)?.message}`);
    }
  }

  /**
   * Returns true if the platform is routable right now.
   *
   * - closed  → always true
   * - open    → false unless the cooldown has elapsed (then transitions to
   *             half-open and returns true for the probe)
   * - half-open → true (one probe allowed; recordSuccess/recordFailure decides)
   */
  canUse(platform: Platform): boolean {
    const snap = this.load(platform);
    if (snap.state === 'closed') return true;
    if (snap.state === 'open') {
      const elapsed = Date.now() - (snap.openedAt ?? 0);
      // Exponential backoff: next probe delay = base cooldown × 2^consecutiveOpens, capped at 5 min
      const backoffFactor = Math.pow(2, snap.consecutiveOpens ?? 0);
      const nextProbeMs = this.cooldownMs * Math.min(backoffFactor, 5);
      const nextProbeAt = (snap.openedAt ?? 0) + nextProbeMs;
      
      if (elapsed >= nextProbeMs && Date.now() >= nextProbeAt) {
        // Cooldown + backoff elapsed — transition to half-open so the next request
        // can probe. We do NOT optimistically mark as closed; the probe
        // has to actually succeed.
        this.save(platform, { ...snap, state: 'half-open' });
        return true;
      }
      return false;
    }
    // half-open: allow one probe
    return true;
  }

  /**
   * Record a transient failure for a platform. Returns true if the breaker
   * transitioned to OPEN as a result (so the caller can log "opened
   * circuit for X"). Idempotent: passing the same error twice doesn't
   * double-count because the check is "consecutive failures within the
   * fail window" — but each new error from the proxy's catch block IS
   * a new failure, so this is the right behavior.
   */
  bumpFail(platform: Platform): { opened: boolean; halfOpenFailed: boolean } {
    const snap = this.load(platform);
    const now = Date.now();
    const withinWindow = (now - snap.lastFailAt) <= this.failWindowMs;
    const newCount = withinWindow ? snap.failCount + 1 : 1;
    let next: BreakerSnapshot = {
      ...snap,
      failCount: newCount,
      lastFailAt: now,
      totalFailures: snap.totalFailures + 1,
    };

    // Half-open probe failure → re-open immediately, increment consecutive opens.
    if (snap.state === 'half-open') {
      next = {
        ...next,
        state: 'open',
        openedAt: now,
        totalOpens: snap.totalOpens + 1,
        consecutiveOpens: (snap.consecutiveOpens ?? 0) + 1,  // increment for exp backoff
      };
      this.save(platform, next);
      return { opened: true, halfOpenFailed: true };
    }

    if (newCount >= this.threshold) {
      next = { ...next, state: 'open', openedAt: now, totalOpens: snap.totalOpens + 1 };
      this.save(platform, next);
      return { opened: true, halfOpenFailed: false };
    }

    this.save(platform, next);
    return { opened: false, halfOpenFailed: false };
  }

  /**
   * Record a success. Resets failCount and consecutiveOpens. If the breaker was half-open
   * (probing), transitions to closed.
   */
  recordSuccess(platform: Platform): void {
    const snap = this.load(platform);
    if (snap.state === 'closed' && snap.failCount === 0 && (snap.consecutiveOpens ?? 0) === 0) return; // no-op fast path
    this.save(platform, {
      ...snap,
      state: 'closed',
      failCount: 0,
      consecutiveOpens: 0,  // reset exp backoff counter on successful recovery
      // Keep lastFailAt as a historical timestamp; reset it on a real
      // recovery so analytics see "last failure was N seconds ago".
      lastFailAt: snap.state === 'half-open' ? 0 : snap.lastFailAt,
      totalSuccesses: snap.totalSuccesses + 1,
    });
  }

  /** Read-only snapshot for the dashboard / logs. */
  snapshot(platform: Platform): BreakerSnapshot {
    return { ...this.load(platform) };
  }

  /** For tests: clear all state. */
  resetForTests(): void {
    this.cache.clear();
  }
}

// Module-level singleton so all callers share state.
const breaker = new CircuitBreaker();
export { breaker };
export { CircuitBreaker }; // exported for tests with custom env
