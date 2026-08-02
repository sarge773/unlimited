/**
 * fallback-logger — observability for the proxy retry loop.
 *
 * Every meaningful event in proxy.ts (a successful attempt, a retryable
 * failure, a breaker open, a tier switch, a chain exhaustion) calls
 * `recordEvent`. The events land in the `fallback_events` table and are
 * surfaced to the dashboard via:
 *
 *   GET /api/fallback/events?limit=200&platform=groq&outcome=success
 *   GET /api/fallback/stats?windowMs=3600000
 *
 * A 7-day prune runs on boot (alongside catalog-sync + free-model-discovery)
 * to keep the table small.
 *
 * Performance: a typical request emits 2-5 events. At 100 reqs/min that's
 * 300-500 rows/min. SQLite handles this trivially; the only thing to be
 * careful of is the per-event INSERT path. We use a prepared statement
 * cached at module load so each call is just a `.run()`.
 */

import { getDb } from '../db/index.js';
import type { Statement } from 'better-sqlite3';

export const EVENT_ = {
  // ── per-attempt outcomes (have a platform + model + latency) ──
  ATTEMPT_SUCCESS:        'attempt_success',
  ATTEMPT_RETRYABLE:      'attempt_retryable',
  ATTEMPT_NON_RETRYABLE:  'attempt_non_retryable',
  ATTEMPT_SKIPPED:        'attempt_skipped',   // breaker open, model filtered out
  ATTEMPT_EMPTY:          'attempt_empty',     // 200 but no content + no tool calls
  // ── structural events (no latency, may not have a platform) ──
  TIER_SWITCH:            'tier_switch',       // local → cloud (or vice versa)
  CHAIN_EXHAUSTED:        'chain_exhausted',   // no more candidates in current tier
  BREAKER_OPEN:           'breaker_open',      // platform-level breaker opened
  BREAKER_CLOSE:          'breaker_close',     // platform-level breaker closed (success)
  // ── request-level outcomes (the "final answer") ──
  REQUEST_SUCCESS:        'request_success',
  REQUEST_FAILED:         'request_failed',
} as const;
export type EventOutcome = typeof EVENT_[keyof typeof EVENT_];

export interface FallbackEvent {
  requestId?: string | null;
  tier: 'local' | 'cloud';
  platform?: string | null;
  model?: string | null;
  outcome: EventOutcome;
  latencyMs?: number | null;
  reason?: string | null;
}

export interface StatsBucket {
  totalEvents: number;
  attemptsByTier: Record<'local' | 'cloud', number>;
  attemptsByPlatform: Record<string, number>;
  outcomes: Record<EventOutcome, number>;
  breakerTransitions: Record<string, { opened: number; closed: number }>;
  // Latency percentiles for successful attempts. Computed in JS from the
  // raw events — SQLite doesn't have a native percentile function.
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  meanAttemptsToSuccess: number | null;
  cloudHitRate: number | null; // 0.0..1.0 — fraction of requests that hit the cloud tier
}

// Re-prepare on each insert. The DB handle is stable across the lifetime
// of a single process, so the cost of preparing is negligible. This
// pattern survives DB swaps (tests, in-memory resets) without needing
// a separate "reset cache" hook.
function insert(): Statement<unknown[]> {
  return getDb().prepare(`
    INSERT INTO fallback_events (request_id, tier, platform, model, outcome, latency_ms, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

/**
 * Record a single event. Cheap — just a prepared statement run. Caller is
 * the proxy retry loop; one call per attempt + a few extras for tier
 * switches and breaker state changes.
 */
export function recordEvent(ev: FallbackEvent): void {
  try {
    insert().run(
      ev.requestId ?? null,
      ev.tier,
      ev.platform ?? null,
      ev.model ?? null,
      ev.outcome,
      ev.latencyMs ?? null,
      ev.reason ?? null,
      Date.now(),
    );
  } catch (e) {
    // Logging is best-effort; never throw from a recording call. A
    // failing insert here would mask the actual proxy error.
    console.warn(`[fallback-logger] insert failed: ${(e as Error)?.message}`);
  }
}

/**
 * Get the most recent N events. The default `limit=200` matches the
 * dashboard's "Fallback activity" panel width.
 */
export interface QueryOpts {
  limit?: number;
  platform?: string;
  outcome?: EventOutcome;
  sinceMs?: number;  // only events newer than this (ms timestamp)
}
export function getRecentEvents(opts: QueryOpts = {}): Array<{
  id: number;
  request_id: string | null;
  tier: 'local' | 'cloud';
  platform: string | null;
  model: string | null;
  outcome: EventOutcome;
  latency_ms: number | null;
  reason: string | null;
  created_at: number;
}> {
  // Note: this returns raw SQL column names (snake_case). The /api/fallback/events
  // route does the snake→camel mapping for the dashboard. Internal callers
  // (e.g. /api/fallback/stats) use snake_case directly. Keeping the snake_case
  // shape here avoids the cost of remapping on every stat query.
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.platform) { where.push('platform = ?'); params.push(opts.platform); }
  if (opts.outcome)  { where.push('outcome = ?');  params.push(opts.outcome); }
  if (opts.sinceMs)  { where.push('created_at >= ?'); params.push(opts.sinceMs); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return getDb().prepare(`
    SELECT id, request_id, tier, platform, model, outcome, latency_ms, reason, created_at
    FROM fallback_events ${whereSql}
    ORDER BY id DESC LIMIT ?
  `).all(...params, limit) as any[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * Aggregate stats over a time window. Returns nulls for percentiles when
 * there are no successful attempts in the window.
 */
export function getStats(windowMs: number = 60 * 60 * 1000): StatsBucket {
  const sinceMs = Date.now() - windowMs;
  const db = getDb();

  const rows = db.prepare(`
    SELECT tier, platform, outcome, latency_ms, request_id
    FROM fallback_events WHERE created_at >= ?
  `).all(sinceMs) as Array<{ tier: string; platform: string | null; outcome: string; latency_ms: number | null; request_id: string | null }>;

  const attemptsByTier: Record<'local' | 'cloud', number> = { local: 0, cloud: 0 };
  const attemptsByPlatform: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  const breakerTransitions: Record<string, { opened: number; closed: number }> = {};
  const latencies: number[] = [];

  for (const r of rows) {
    outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
    if (r.outcome.startsWith('attempt_')) {
      attemptsByTier[r.tier as 'local' | 'cloud'] = (attemptsByTier[r.tier as 'local' | 'cloud'] || 0) + 1;
      if (r.platform) {
        attemptsByPlatform[r.platform] = (attemptsByPlatform[r.platform] || 0) + 1;
      }
      if (r.outcome === 'attempt_success' && typeof r.latency_ms === 'number') {
        latencies.push(r.latency_ms);
      }
    } else if (r.outcome === 'breaker_open' || r.outcome === 'breaker_close') {
      if (r.platform) {
        if (!breakerTransitions[r.platform]) breakerTransitions[r.platform] = { opened: 0, closed: 0 };
        if (r.outcome === 'breaker_open') breakerTransitions[r.platform].opened++;
        else breakerTransitions[r.platform].closed++;
      }
    }
  }

  latencies.sort((a, b) => a - b);

  // Mean attempts per request_id that eventually succeeded
  const requestAttempts = new Map<string, number>();
  for (const r of rows) {
    if (r.outcome.startsWith('attempt_') && r.request_id) {
      requestAttempts.set(r.request_id, (requestAttempts.get(r.request_id) || 0) + 1);
    }
  }
  const successfulRequestAttempts: number[] = [];
  const successfulRequestIds = new Set<string>();
  for (const r of rows) {
    if (r.outcome === 'attempt_success' && r.request_id) {
      successfulRequestIds.add(r.request_id);
    }
  }
  for (const id of successfulRequestIds) {
    const n = requestAttempts.get(id) || 0;
    if (n > 0) successfulRequestAttempts.push(n);
  }
  const meanAttemptsToSuccess = successfulRequestAttempts.length > 0
    ? successfulRequestAttempts.reduce((a, b) => a + b, 0) / successfulRequestAttempts.length
    : null;

  // Cloud hit rate: requests that emitted any cloud-tier event / total requests
  const totalRequests = new Set<string>();
  const cloudRequests = new Set<string>();
  for (const r of rows) {
    if (r.request_id) {
      totalRequests.add(r.request_id);
      if (r.tier === 'cloud') cloudRequests.add(r.request_id);
    }
  }
  const cloudHitRate = totalRequests.size > 0 ? cloudRequests.size / totalRequests.size : null;

  return {
    totalEvents: rows.length,
    attemptsByTier,
    attemptsByPlatform,
    outcomes: outcomes as StatsBucket['outcomes'],
    breakerTransitions,
    p50LatencyMs: latencies.length > 0 ? percentile(latencies, 0.5) : null,
    p95LatencyMs: latencies.length > 0 ? percentile(latencies, 0.95) : null,
    meanAttemptsToSuccess,
    cloudHitRate,
  };
}

/** Delete events older than the retention window. Called on boot. */
export function purgeOldEvents(maxAgeDays: number = 7): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const result = getDb().prepare(`DELETE FROM fallback_events WHERE created_at < ?`).run(cutoff);
  return result.changes;
}
