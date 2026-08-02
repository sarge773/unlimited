// Unit tests for the fallback observability logger (Phase 4).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

describe('fallback-logger', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.NODE_ENV = 'test';
  });

  beforeEach(async () => {
    const { initDb } = await import('../../db/index.js');
    initDb(`:memory:${Math.random()}`);
  });

  it('recordEvent inserts a row', async () => {
    const { recordEvent, getRecentEvents } = await import('../../services/fallback-logger.js');
    recordEvent({
      requestId: 'req-1',
      tier: 'local',
      platform: 'groq',
      model: 'gpt-oss-120b',
      outcome: 'attempt_success',
      latencyMs: 250,
    });
    // getRecentEvents returns raw SQL rows (snake_case) — the API endpoint
    // does the snake→camel mapping. Tests work with the raw shape.
    const events = getRecentEvents({ limit: 10 });
    const last = events.find(e => e.request_id === 'req-1');
    expect(last).toBeDefined();
    expect(last!.platform).toBe('groq');
    expect(last!.outcome).toBe('attempt_success');
    expect(last!.latency_ms).toBe(250);
  });

  it('getRecentEvents filters by platform', async () => {
    const { recordEvent, getRecentEvents } = await import('../../services/fallback-logger.js');
    recordEvent({ tier: 'local', platform: 'groq', outcome: 'attempt_success' });
    recordEvent({ tier: 'local', platform: 'cerebras', outcome: 'attempt_success' });
    recordEvent({ tier: 'local', platform: 'openrouter', outcome: 'attempt_retryable' });
    const groq = getRecentEvents({ platform: 'groq' });
    expect(groq.every(e => e.platform === 'groq')).toBe(true);
    expect(groq.length).toBeGreaterThan(0);
  });

  it('getRecentEvents filters by outcome', async () => {
    const { recordEvent, getRecentEvents } = await import('../../services/fallback-logger.js');
    recordEvent({ tier: 'local', platform: 'groq', outcome: 'attempt_success', requestId: 'a' });
    recordEvent({ tier: 'local', platform: 'cerebras', outcome: 'attempt_retryable', requestId: 'b' });
    recordEvent({ tier: 'local', platform: 'openrouter', outcome: 'breaker_open', requestId: 'c' });
    const opens = getRecentEvents({ outcome: 'breaker_open' });
    expect(opens.every(e => e.outcome === 'breaker_open')).toBe(true);
  });

  it('getRecentEvents respects limit (capped at 2000)', async () => {
    const { recordEvent, getRecentEvents } = await import('../../services/fallback-logger.js');
    for (let i = 0; i < 10; i++) {
      recordEvent({ tier: 'local', outcome: 'attempt_success', requestId: `r${i}` });
    }
    const events = getRecentEvents({ limit: 5 });
    expect(events.length).toBeLessThanOrEqual(5);
  });

  it('getStats aggregates attempts by tier and platform', async () => {
    const { recordEvent, getStats } = await import('../../services/fallback-logger.js');
    recordEvent({ tier: 'local', platform: 'groq', outcome: 'attempt_success', latencyMs: 200, requestId: 'r1' });
    recordEvent({ tier: 'local', platform: 'groq', outcome: 'attempt_success', latencyMs: 400, requestId: 'r2' });
    recordEvent({ tier: 'local', platform: 'cerebras', outcome: 'attempt_retryable', requestId: 'r1' });
    recordEvent({ tier: 'cloud', platform: 'openrouter', outcome: 'attempt_success', latencyMs: 800, requestId: 'r1' });
    recordEvent({ tier: 'cloud', platform: 'openrouter', outcome: 'breaker_open', requestId: 'r2' });

    const stats = getStats(60 * 60 * 1000);
    expect(stats.attemptsByTier.local).toBe(3);
    expect(stats.attemptsByTier.cloud).toBe(1);
    expect(stats.attemptsByPlatform.groq).toBe(2);
    expect(stats.attemptsByPlatform.cerebras).toBe(1);
    expect(stats.attemptsByPlatform.openrouter).toBe(1);
    expect(stats.breakerTransitions.openrouter?.opened).toBe(1);
    expect(stats.p50LatencyMs).toBe(400);
    expect(stats.p95LatencyMs).toBe(800);
    // mean attempts to success: r1 took 3, r2 took 1, mean = 2
    expect(stats.meanAttemptsToSuccess).toBe(2);
  });

  it('getStats cloudHitRate counts requests that hit the cloud tier', async () => {
    const { recordEvent, getStats } = await import('../../services/fallback-logger.js');
    recordEvent({ tier: 'local', outcome: 'attempt_success', requestId: 'r1' });
    recordEvent({ tier: 'local', outcome: 'attempt_retryable', requestId: 'r2' });
    recordEvent({ tier: 'cloud', outcome: 'attempt_success', requestId: 'r2' });
    recordEvent({ tier: 'cloud', outcome: 'attempt_success', requestId: 'r3' });

    const stats = getStats(60 * 60 * 1000);
    expect(stats.cloudHitRate).toBeCloseTo(2 / 3);
  });

  it('getStats returns null percentiles when no successful attempts exist', async () => {
    const { recordEvent, getStats } = await import('../../services/fallback-logger.js');
    recordEvent({ tier: 'local', outcome: 'attempt_retryable', requestId: 'r1' });
    const stats = getStats(60 * 60 * 1000);
    expect(stats.p50LatencyMs).toBeNull();
    expect(stats.p95LatencyMs).toBeNull();
  });

  it('purgeOldEvents deletes rows older than maxAgeDays', async () => {
    const { recordEvent, getRecentEvents, purgeOldEvents } = await import('../../services/fallback-logger.js');
    const { getDb } = await import('../../db/index.js');
    recordEvent({ tier: 'local', outcome: 'attempt_success', requestId: 'old' });
    getDb().prepare(`UPDATE fallback_events SET created_at = ? WHERE request_id = 'old'`).run(Date.now() - 8 * 24 * 60 * 60 * 1000);
    recordEvent({ tier: 'local', outcome: 'attempt_success', requestId: 'new' });
    const removed = purgeOldEvents(7);
    expect(removed).toBe(1);
    const remaining = getRecentEvents({});
    expect(remaining.find(e => e.request_id === 'old')).toBeUndefined();
    expect(remaining.find(e => e.request_id === 'new')).toBeDefined();
  });
});
