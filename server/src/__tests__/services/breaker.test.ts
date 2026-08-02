// Unit tests for the per-platform circuit breaker (Phase 3).
import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';

describe('CircuitBreaker', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.NODE_ENV = 'test';
  });

  beforeEach(async () => {
    const { initDb } = await import('../../db/index.js');
    // Use a fresh in-memory DB per test so persisted state from the
    // settings table doesn't leak.
    initDb(`:memory:${Math.random()}`);
  });

  afterEach(() => {
    // No-op: each test gets a fresh DB via initDb.
  });

  it('starts closed and canUse returns true', async () => {
    const { CircuitBreaker } = await import('../../services/breaker.js');
    const b = new CircuitBreaker();
    expect(b.canUse('openrouter' as any)).toBe(true);
    expect(b.snapshot('openrouter' as any).state).toBe('closed');
  });

  it('opens after 3 consecutive failures within the window', async () => {
    const { CircuitBreaker } = await import('../../services/breaker.js');
    const b = new CircuitBreaker();
    expect(b.bumpFail('groq' as any).opened).toBe(false);
    expect(b.bumpFail('groq' as any).opened).toBe(false);
    const r = b.bumpFail('groq' as any);
    expect(r.opened).toBe(true);
    expect(b.snapshot('groq' as any).state).toBe('open');
    expect(b.canUse('groq' as any)).toBe(false);
  });

  it('respects a custom threshold', async () => {
    const { CircuitBreaker } = await import('../../services/breaker.js');
    const b = new CircuitBreaker({ threshold: 5 });
    for (let i = 0; i < 4; i++) {
      expect(b.bumpFail('cerebras' as any).opened).toBe(false);
    }
    expect(b.bumpFail('cerebras' as any).opened).toBe(true);
  });

  it('resets failCount when a success is recorded', async () => {
    const { CircuitBreaker } = await import('../../services/breaker.js');
    const b = new CircuitBreaker();
    b.bumpFail('openrouter' as any);
    b.bumpFail('openrouter' as any);
    expect(b.snapshot('openrouter' as any).failCount).toBe(2);
    b.recordSuccess('openrouter' as any);
    expect(b.snapshot('openrouter' as any).failCount).toBe(0);
    expect(b.snapshot('openrouter' as any).state).toBe('closed');
  });

  it('transitions to half-open after the cooldown elapses', async () => {
    const { CircuitBreaker } = await import('../../services/breaker.js');
    const b = new CircuitBreaker({ cooldownMs: 50 }); // tiny cooldown for test speed
    b.bumpFail('groq' as any);
    b.bumpFail('groq' as any);
    b.bumpFail('groq' as any); // open
    expect(b.canUse('groq' as any)).toBe(false);

    // Wait past the cooldown
    await new Promise(r => setTimeout(r, 70));
    // canUse detects the elapsed cooldown, transitions to half-open, returns true
    expect(b.canUse('groq' as any)).toBe(true);
    expect(b.snapshot('groq' as any).state).toBe('half-open');
  });

  it('half-open probe failure re-opens the breaker immediately', async () => {
    const { CircuitBreaker } = await import('../../services/breaker.js');
    const b = new CircuitBreaker({ cooldownMs: 30 });
    b.bumpFail('mistral' as any);
    b.bumpFail('mistral' as any);
    b.bumpFail('mistral' as any); // open
    await new Promise(r => setTimeout(r, 40));
    b.canUse('mistral' as any); // transitions to half-open
    expect(b.snapshot('mistral' as any).state).toBe('half-open');

    // Probe fails → re-open
    const r = b.bumpFail('mistral' as any);
    expect(r.halfOpenFailed).toBe(true);
    expect(r.opened).toBe(true);
    expect(b.snapshot('mistral' as any).state).toBe('open');
  });

  it('half-open probe success closes the breaker', async () => {
    const { CircuitBreaker } = await import('../../services/breaker.js');
    const b = new CircuitBreaker({ cooldownMs: 30 });
    b.bumpFail('github' as any);
    b.bumpFail('github' as any);
    b.bumpFail('github' as any); // open
    await new Promise(r => setTimeout(r, 40));
    b.canUse('github' as any); // → half-open
    b.recordSuccess('github' as any);
    expect(b.snapshot('github' as any).state).toBe('closed');
    expect(b.canUse('github' as any)).toBe(true);
  });

  it('persists state to the settings table and recovers on reload', async () => {
    const { CircuitBreaker } = await import('../../services/breaker.js');
    const { getDb } = await import('../../db/index.js');

    // Open the breaker on platform A
    const b1 = new CircuitBreaker();
    b1.bumpFail('huggingface' as any);
    b1.bumpFail('huggingface' as any);
    b1.bumpFail('huggingface' as any);
    expect(b1.snapshot('huggingface' as any).state).toBe('open');

    // Simulate a process restart: create a new breaker instance. It should
    // load the state from the settings table.
    const b2 = new CircuitBreaker();
    // First canUse will see the open state (cooldown hasn't elapsed)
    expect(b2.canUse('huggingface' as any)).toBe(false);
    expect(b2.snapshot('huggingface' as any).state).toBe('open');
    expect(b2.snapshot('huggingface' as any).totalFailures).toBe(3);

    // Other platforms stay closed
    expect(b2.canUse('ollama' as any)).toBe(true);
  });

  it('isolates per-platform state', async () => {
    const { CircuitBreaker } = await import('../../services/breaker.js');
    const b = new CircuitBreaker();
    // Open groq
    b.bumpFail('groq' as any);
    b.bumpFail('groq' as any);
    b.bumpFail('groq' as any);
    expect(b.snapshot('groq' as any).state).toBe('open');
    // Other platforms are unaffected
    expect(b.snapshot('cerebras' as any).state).toBe('closed');
    expect(b.canUse('cerebras' as any)).toBe(true);
  });

  it('tracks total counters for analytics', async () => {
    const { CircuitBreaker } = await import('../../services/breaker.js');
    const b = new CircuitBreaker();
    b.bumpFail('openrouter' as any);
    b.bumpFail('openrouter' as any);
    b.recordSuccess('openrouter' as any);
    b.bumpFail('openrouter' as any);
    const s = b.snapshot('openrouter' as any);
    expect(s.totalFailures).toBe(3);
    expect(s.totalSuccesses).toBe(1);
  });
});
