// ── Per-model latency monitoring ─────────────────────────────────────────
//
// Track rolling p50/p95 latency per model. After 10+ samples, if p95 > 10s,
// mark the model for soft throttling (deprioritize in routing). This prevents
// the router from repeatedly trying slow providers that technically work but
// make users wait a long time.
//
// Latency here = time from request start to first response byte (or first error).
// Does not include streaming time (that's on the client).

export interface LatencyStats {
  modelDbId: number;
  p50Ms: number;
  p95Ms: number;
  sampleCount: number;
}

// Rolling window of latencies per model. Keep most recent 100 samples.
const latencyBuckets = new Map<number, number[]>();
const MAX_BUCKET_SIZE = 100;
const MIN_SAMPLES_FOR_THROTTLE = 10;
const P95_THRESHOLD_MS = 10000;  // 10s threshold for soft throttle

/**
 * Record a latency measurement for a model.
 * @param modelDbId - model database id
 * @param latencyMs - response time in milliseconds
 */
export function recordLatency(modelDbId: number, latencyMs: number): void {
  let bucket = latencyBuckets.get(modelDbId);
  if (!bucket) {
    bucket = [];
    latencyBuckets.set(modelDbId, bucket);
  }
  bucket.push(latencyMs);
  // FIFO: keep most recent MAX_BUCKET_SIZE samples
  if (bucket.length > MAX_BUCKET_SIZE) {
    bucket.shift();
  }
}

/**
 * Get current latency statistics for a model.
 */
export function getLatencyStats(modelDbId: number): LatencyStats | null {
  const bucket = latencyBuckets.get(modelDbId);
  if (!bucket || bucket.length === 0) return null;
  
  const sorted = [...bucket].sort((a, b) => a - b);
  return {
    modelDbId,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    sampleCount: bucket.length,
  };
}

/**
 * Check if a model should be soft-throttled (deprioritized) due to high latency.
 * Returns true if we have enough samples and p95 exceeds the threshold.
 */
export function shouldSoftThrottle(modelDbId: number): boolean {
  const stats = getLatencyStats(modelDbId);
  if (!stats || stats.sampleCount < MIN_SAMPLES_FOR_THROTTLE) {
    return false;  // not enough data yet
  }
  return stats.p95Ms > P95_THRESHOLD_MS;
}

/**
 * Clear all recorded latencies. Used for testing.
 */
export function resetForTests(): void {
  latencyBuckets.clear();
}
