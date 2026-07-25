// Sliding window rate limit tracker with SQLite persistence.

import { getDb } from '../db/index.js';

interface Window {
  timestamps: number[];
  tokenCount: number;
  tokenTimestamps: { ts: number; tokens: number }[];
}

// Key format: "platform:modelId:keyId:type" where type is rpm|rpd|tpm|tpd
const windows = new Map<string, Window>();
type RateLimitDb = ReturnType<typeof getDb>;
type UsageKind = 'request' | 'tokens';

function getWindow(key: string): Window {
  let w = windows.get(key);
  if (!w) {
    w = { timestamps: [], tokenCount: 0, tokenTimestamps: [] };
    windows.set(key, w);
  }
  return w;
}

function pruneTimestamps(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter(ts => ts > cutoff);
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Milliseconds elapsed since the most recent midnight UTC. Used as the window
 *  width for provider-account daily caps, which reset on a day boundary rather
 *  than sliding. Never exceeds DAY, so it stays inside the usage-table retention. */
function msSinceUtcMidnight(now: number): number {
  return now - new Date(now).setUTCHours(0, 0, 0, 0);
}

function withDb<T>(fn: (db: RateLimitDb) => T): T | undefined {
  try {
    return fn(getDb());
  } catch {
    return undefined;
  }
}

// ── In-flight leases ──────────────────────────────────────────────────────────
// Usage is only recorded *after* an attempt succeeds, so between key selection
// and that write the router has no idea a request is already in the air. A lease
// makes that window visible. Today it backs the per-key concurrency cap; it is
// also the hook for counting provisional usage against the quota gates, which is
// what closes the check-then-act race under parallel load.
//
// Leases live in memory only: they describe requests this process currently has
// open, so there is nothing meaningful to persist and a restart correctly starts
// from zero.

interface Lease {
  platform: string;
  modelId: string;
  keyId: number;
  tokens: number;
  createdAt: number;
}

const leases = new Map<number, Lease>();
let nextLeaseId = 1;

// A lease should always be released explicitly by the fallback loop's finally
// block. This bound is the backstop for a path that somehow doesn't: without it
// a single leaked lease would count against a key's concurrency budget forever.
// Comfortably longer than the per-attempt provider timeout.
const LEASE_MAX_AGE_MS = 2 * MINUTE;

function pruneLeases(now: number): void {
  if (leases.size === 0) return;
  for (const [id, lease] of leases) {
    if (now - lease.createdAt > LEASE_MAX_AGE_MS) leases.delete(id);
  }
}

/**
 * Concurrent in-flight requests allowed per key, or null for unlimited.
 *
 * Some free tiers meter concurrency per credential rather than per minute, so
 * parallel streams on one key mostly 429 each other. But most do not, and
 * capping by default would serialise every provider and cost real throughput —
 * so this is opt-in. There is deliberately no built-in per-platform table: the
 * providers that behave this way are not documented well enough to assert a
 * number for them here, and a wrong default is worse than none.
 *
 * `MAX_CONCURRENT_REQUESTS_PER_KEY_<PLATFORM>` sets it for one platform;
 * `MAX_CONCURRENT_REQUESTS_PER_KEY` sets a fallback for all of them.
 */
export function getKeyConcurrencyLimit(platform: string): number | null {
  const raw = process.env[`MAX_CONCURRENT_REQUESTS_PER_KEY_${platform.toUpperCase()}`]
    ?? process.env.MAX_CONCURRENT_REQUESTS_PER_KEY;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** Requests this process currently has in flight against one platform+key. */
export function inFlightForKey(platform: string, keyId: number, now = Date.now()): number {
  pruneLeases(now);
  let count = 0;
  for (const lease of leases.values()) {
    if (lease.platform === platform && lease.keyId === keyId) count++;
  }
  return count;
}

/** False when this key already has its allowed number of requests in the air.
 *  Always true when no cap is configured, which is the default. */
export function canUseKeyConcurrency(platform: string, keyId: number, now = Date.now()): boolean {
  const limit = getKeyConcurrencyLimit(platform);
  if (limit === null) return true;
  return inFlightForKey(platform, keyId, now) < limit;
}

/** Take a lease for an attempt about to be dispatched. Returns the id to release. */
export function acquireLease(
  platform: string,
  modelId: string,
  keyId: number,
  tokens: number,
  now = Date.now(),
): number {
  pruneLeases(now);
  const id = nextLeaseId++;
  leases.set(id, { platform, modelId, keyId, tokens, createdAt: now });
  return id;
}

/** Release a lease. Idempotent, so a double release from overlapping cleanup
 *  paths is harmless. */
export function releaseLease(leaseId: number): void {
  leases.delete(leaseId);
}

/** Test seam: drop all leases. */
export function resetLeases(): void {
  leases.clear();
}

// ── Provisional usage ─────────────────────────────────────────────────────────
// Every gate below adds in-flight leases on top of the recorded counters. This is
// what closes the check-then-act race: routeRequest is synchronous but usage is
// only written after the awaited provider call, so N concurrent requests all read
// the same pre-check and every one of them passes — then they collectively blow
// through the limit and collect real 429s. Counting leases makes the second
// caller see the first one's request.
//
// A lease is released just after the success write, so for a brief instant a
// completed request is counted twice. That errs toward under-dispatching by one,
// which is the safe direction for a free tier, and lasts microseconds.

function provisionalRequests(platform: string, modelId: string, keyId: number, now: number): number {
  pruneLeases(now);
  let count = 0;
  for (const lease of leases.values()) {
    if (lease.platform === platform && lease.modelId === modelId && lease.keyId === keyId) count++;
  }
  return count;
}

function provisionalTokens(platform: string, modelId: string, keyId: number, now: number): number {
  pruneLeases(now);
  let total = 0;
  for (const lease of leases.values()) {
    if (lease.platform === platform && lease.modelId === modelId && lease.keyId === keyId) total += lease.tokens;
  }
  return total;
}

/** In-flight requests for a provider account+key across every model — the
 *  provider-wide analogue, for the account-level gates. */
function provisionalProviderRequests(platform: string, keyId: number, now: number): number {
  return inFlightForKey(platform, keyId, now);
}

function provisionalProviderTokens(platform: string, keyId: number, now: number): number {
  pruneLeases(now);
  let total = 0;
  for (const lease of leases.values()) {
    if (lease.platform === platform && lease.keyId === keyId) total += lease.tokens;
  }
  return total;
}

function recordUsage(
  platform: string,
  modelId: string,
  keyId: number,
  kind: UsageKind,
  tokens: number,
  now: number,
) {
  withDb(db => {
    db.prepare(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, kind, tokens, now);
    db.prepare('DELETE FROM rate_limit_usage WHERE created_at_ms <= ?').run(now - DAY);
  });
}

function countPersistedRequests(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT COUNT(*) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
         AND kind = 'request'
         AND created_at_ms > ?
    `).get(platform, modelId, keyId, now - windowMs) as { used: number };
    return row.used;
  });
}

function sumPersistedTokens(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT COALESCE(SUM(tokens), 0) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
         AND kind = 'tokens'
         AND created_at_ms > ?
    `).get(platform, modelId, keyId, now - windowMs) as { used: number };
    return row.used;
  });
}

function memoryRequestCount(key: string, windowMs: number, now: number): number {
  const w = getWindow(key);
  w.timestamps = pruneTimestamps(w.timestamps, windowMs, now);
  return w.timestamps.length;
}

function memoryTokenCount(key: string, windowMs: number, now: number): number {
  const w = getWindow(key);
  w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - windowMs);
  return w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
}

function requestCount(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number {
  const persisted = countPersistedRequests(platform, modelId, keyId, windowMs, now);
  if (persisted !== undefined) return persisted;
  const type = windowMs === MINUTE ? 'rpm' : 'rpd';
  return memoryRequestCount(`${platform}:${modelId}:${keyId}:${type}`, windowMs, now);
}

function tokenCount(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number {
  const persisted = sumPersistedTokens(platform, modelId, keyId, windowMs, now);
  if (persisted !== undefined) return persisted;
  const type = windowMs === MINUTE ? 'tpm' : 'tpd';
  return memoryTokenCount(`${platform}:${modelId}:${keyId}:${type}`, windowMs, now);
}

export function canMakeRequest(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();
  // In-flight requests count against both windows: a lease means the request is
  // happening now, so it belongs to this minute and to today.
  const inFlight = provisionalRequests(platform, modelId, keyId, now);

  if (limits.rpm !== null) {
    if (requestCount(platform, modelId, keyId, MINUTE, now) + inFlight >= limits.rpm) return false;
  }

  if (limits.rpd !== null) {
    if (requestCount(platform, modelId, keyId, DAY, now) + inFlight >= limits.rpd) return false;
  }

  return true;
}

export function canUseTokens(
  platform: string,
  modelId: string,
  keyId: number,
  estimatedTokens: number,
  limits: { tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();
  // Tokens already promised to in-flight attempts on this model+key.
  const inFlight = provisionalTokens(platform, modelId, keyId, now);

  if (limits.tpm !== null) {
    const used = tokenCount(platform, modelId, keyId, MINUTE, now);
    if (used + inFlight + estimatedTokens > limits.tpm) return false;
  }

  if (limits.tpd !== null) {
    const used = tokenCount(platform, modelId, keyId, DAY, now);
    if (used + inFlight + estimatedTokens > limits.tpd) return false;
  }

  return true;
}

// ── Provider-wide daily request caps (#162) ──
// Some providers enforce one daily REQUEST quota across the WHOLE account,
// shared by every model — not per model. OpenRouter's free tier is the classic
// case: ~1000 requests/day total (50/day if you've bought <10 credits) no
// matter how many different free models you spread them across. The
// per-(platform,model,key) rpd ledger can't see that, so without a provider-wide
// gate the router happily fires (models × rpd) requests and earns surprise 429s.
//
// Defaults below; override per provider with an env var, e.g.
//   PROVIDER_DAILY_REQUEST_CAP_OPENROUTER=50   (set 0 to disable the cap)
const DEFAULT_PROVIDER_DAILY_REQUEST_CAPS: Record<string, number> = {
  openrouter: 1000,
};

const DEFAULT_PROVIDER_DAILY_TOKEN_CAPS: Record<string, number> = {
  // NavyAI's free plan is one shared 150K-token/day pool per key. Individual
  // models carry token_multiplier values, so the provider-visible drain can be
  // higher than the OpenAI usage.total_tokens returned by /chat/completions.
  navy: 150_000,
};

// Per-minute caps that apply to the whole provider account rather than one model.
// The per-model rpm_limit cannot express these: NVIDIA NIM meters ~40 requests a
// minute across the entire account, so glm-4.7, minimax-m3 and deepseek all draw
// from one bucket. Without an account-level gate the router sees each model's own
// rpm as unspent — and a model row whose rpm_limit is NULL escapes pre-throttling
// entirely — so it keeps dispatching and eats real 429s.
const DEFAULT_PROVIDER_MINUTE_REQUEST_CAPS: Record<string, number> = {
  nvidia: 40,
};

export function getProviderDailyRequestCap(platform: string): number | null {
  const raw = process.env[`PROVIDER_DAILY_REQUEST_CAP_${platform.toUpperCase()}`];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n === 0 ? null : n;
  }
  return DEFAULT_PROVIDER_DAILY_REQUEST_CAPS[platform] ?? null;
}

/** Account-wide requests-per-minute cap, or null when the provider has none.
 *  `PROVIDER_MINUTE_REQUEST_CAP_<PLATFORM>=0` disables the gate for that platform. */
export function getProviderMinuteRequestCap(platform: string): number | null {
  const raw = process.env[`PROVIDER_MINUTE_REQUEST_CAP_${platform.toUpperCase()}`];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n === 0 ? null : n;
  }
  return DEFAULT_PROVIDER_MINUTE_REQUEST_CAPS[platform] ?? null;
}

export function getProviderDailyTokenCap(platform: string): number | null {
  const raw = process.env[`PROVIDER_DAILY_TOKEN_CAP_${platform.toUpperCase()}`];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n === 0 ? null : n;
  }
  return DEFAULT_PROVIDER_DAILY_TOKEN_CAPS[platform] ?? null;
}

function countPersistedProviderRequests(
  platform: string,
  keyId: number,
  windowMs: number,
  now: number,
): number | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT COUNT(*) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND key_id = ?
         AND kind = 'request'
         AND created_at_ms > ?
    `).get(platform, keyId, now - windowMs) as { used: number };
    return row.used;
  });
}

// Total requests today for a provider account+key, summed across every model.
// "Today" is the window since midnight UTC, not a sliding 24h: real provider
// account caps (OpenRouter, NVIDIA) reset on a wall-clock day boundary, so a
// sliding window keeps a provider benched well past its actual reset — a burst
// at 23:00 UTC would still be counted against the account at 22:00 the next day.
export function providerDailyRequestCount(platform: string, keyId: number, now = Date.now()): number {
  const windowMs = msSinceUtcMidnight(now);
  const persisted = countPersistedProviderRequests(platform, keyId, windowMs, now);
  if (persisted !== undefined) return persisted;
  // DB-unavailable fallback: sum the per-model rpd windows for this platform+key.
  // Window key format is "platform:modelId:keyId:rpd" (modelId may contain ':').
  let total = 0;
  for (const [key, w] of windows) {
    if (key.startsWith(`${platform}:`) && key.endsWith(`:${keyId}:rpd`)) {
      total += pruneTimestamps(w.timestamps, windowMs, now).length;
    }
  }
  return total;
}

// False when this provider account+key has hit its shared daily request cap, so
// the router skips every model on that provider for this key until UTC-ish reset.
export function canUseProvider(platform: string, keyId: number, now = Date.now()): boolean {
  const cap = getProviderDailyRequestCap(platform);
  if (cap === null) return true;
  const used = providerDailyRequestCount(platform, keyId, now) + provisionalProviderRequests(platform, keyId, now);
  return used < cap;
}

/** Requests in the last minute for a provider account+key, across every model. */
export function providerMinuteRequestCount(platform: string, keyId: number, now = Date.now()): number {
  const persisted = countPersistedProviderRequests(platform, keyId, MINUTE, now);
  if (persisted !== undefined) return persisted;
  // DB-unavailable fallback: sum the per-model rpm windows for this platform+key.
  let total = 0;
  for (const [key, w] of windows) {
    if (key.startsWith(`${platform}:`) && key.endsWith(`:${keyId}:rpm`)) {
      total += pruneTimestamps(w.timestamps, MINUTE, now).length;
    }
  }
  return total;
}

// False when this provider account+key has spent its shared per-minute request
// budget, so the router skips every model on that provider rather than learning
// the limit again from a 429 on each one in turn.
export function canUseProviderMinute(platform: string, keyId: number, now = Date.now()): boolean {
  const cap = getProviderMinuteRequestCap(platform);
  if (cap === null) return true;
  const used = providerMinuteRequestCount(platform, keyId, now) + provisionalProviderRequests(platform, keyId, now);
  return used < cap;
}

type ModelQuotaRow = { tpd_limit: number | null; monthly_token_budget: string | null };

function multiplierFromQuotaRow(row: ModelQuotaRow | undefined, dailyCap: number): number {
  if (!row) return 1;

  const fromLabel = row.monthly_token_budget?.match(/(?:^|[\u00b7(\s])(\d+(?:\.\d+)?)x\b/i);
  if (fromLabel) {
    const n = Number(fromLabel[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const tpd = row.tpd_limit;
  if (tpd != null && tpd > 0 && tpd < dailyCap) return dailyCap / tpd;
  return 1;
}

function getProviderTokenMultiplier(platform: string, modelId: string, dailyCap: number): number {
  if (platform !== 'navy') return 1;
  return withDb(db => {
    const row = db.prepare(`
      SELECT tpd_limit, monthly_token_budget
        FROM models
       WHERE platform = ? AND model_id = ?
       LIMIT 1
    `).get(platform, modelId) as ModelQuotaRow | undefined;
    return multiplierFromQuotaRow(row, dailyCap);
  }) ?? 1;
}

function providerBilledTokens(platform: string, modelId: string, rawTokens: number): number {
  if (rawTokens <= 0) return 0;
  const dailyCap = getProviderDailyTokenCap(platform);
  if (dailyCap === null) return rawTokens;
  const multiplier = getProviderTokenMultiplier(platform, modelId, dailyCap);
  return Math.ceil(rawTokens * multiplier);
}

function sumPersistedProviderTokens(
  platform: string,
  keyId: number,
  windowMs: number,
  now: number,
): number | undefined {
  const dailyCap = getProviderDailyTokenCap(platform);
  if (dailyCap === null) return 0;

  return withDb(db => {
    const rows = db.prepare(`
      SELECT rlu.model_id, COALESCE(SUM(rlu.tokens), 0) AS used,
             m.tpd_limit, m.monthly_token_budget
        FROM rate_limit_usage rlu
        LEFT JOIN models m ON m.platform = rlu.platform AND m.model_id = rlu.model_id
       WHERE rlu.platform = ?
         AND rlu.key_id = ?
         AND rlu.kind = 'tokens'
         AND rlu.created_at_ms > ?
       GROUP BY rlu.model_id
    `).all(platform, keyId, now - windowMs) as (ModelQuotaRow & { model_id: string; used: number })[];

    return rows.reduce((sum, row) => {
      const multiplier = platform === 'navy' ? multiplierFromQuotaRow(row, dailyCap) : 1;
      return sum + Math.ceil(row.used * multiplier);
    }, 0);
  });
}

// Midnight-UTC boundary, for the same reason as providerDailyRequestCount.
export function providerDailyTokenCount(platform: string, keyId: number, now = Date.now()): number {
  const windowMs = msSinceUtcMidnight(now);
  const persisted = sumPersistedProviderTokens(platform, keyId, windowMs, now);
  if (persisted !== undefined) return persisted;

  let total = 0;
  const suffix = `:${keyId}:tpd`;
  for (const [key, w] of windows) {
    if (!key.startsWith(`${platform}:`) || !key.endsWith(suffix)) continue;
    const modelId = key.slice(platform.length + 1, -suffix.length);
    // Read-only: the tpd window is shared with the per-model 24h token check, so
    // narrowing it to the midnight boundary here must not prune the stored entries.
    const raw = w.tokenTimestamps
      .filter(t => t.ts > now - windowMs)
      .reduce((sum, t) => sum + t.tokens, 0);
    total += providerBilledTokens(platform, modelId, raw);
  }
  return total;
}

export function canUseProviderTokens(
  platform: string,
  keyId: number,
  modelId: string,
  estimatedTokens: number,
  now = Date.now(),
): boolean {
  const cap = getProviderDailyTokenCap(platform);
  if (cap === null) return true;
  const used = providerDailyTokenCount(platform, keyId, now)
    + providerBilledTokens(platform, modelId, provisionalProviderTokens(platform, keyId, now));
  return used + providerBilledTokens(platform, modelId, estimatedTokens) <= cap;
}

export function recordRequest(platform: string, modelId: string, keyId: number) {
  const now = Date.now();

  const rpmKey = `${platform}:${modelId}:${keyId}:rpm`;
  getWindow(rpmKey).timestamps.push(now);

  const rpdKey = `${platform}:${modelId}:${keyId}:rpd`;
  getWindow(rpdKey).timestamps.push(now);

  recordUsage(platform, modelId, keyId, 'request', 0, now);
  clearNullLimitHits(platform, modelId, keyId);
}

export function recordTokens(
  platform: string,
  modelId: string,
  keyId: number,
  tokens: number,
) {
  const now = Date.now();

  const tpmKey = `${platform}:${modelId}:${keyId}:tpm`;
  getWindow(tpmKey).tokenTimestamps.push({ ts: now, tokens });

  const tpdKey = `${platform}:${modelId}:${keyId}:tpd`;
  getWindow(tpdKey).tokenTimestamps.push({ ts: now, tokens });

  recordUsage(platform, modelId, keyId, 'tokens', tokens, now);
}

// Cooldown: when a provider returns 429, block that model+key for a period
const cooldowns = new Map<string, number>(); // key -> expiry timestamp

// Escalating cooldown: track hits per key over a rolling 24h window so a
// daily-quota exhaustion (OpenRouter free: 50/day, Cohere free: 33/day, etc.)
// quarantines the key for the rest of the day instead of looping through
// the 2-minute cooldown 20 times per request and consuming every fallback slot.
// In-memory only — state resets on restart, which is fine (a clean restart
// will re-escalate on the next 429 if the quota is genuinely exhausted).
const cooldownHits = new Map<string, number[]>(); // key -> timestamps of recent cooldown set events
const HOUR = 60 * MINUTE;
const COOLDOWN_DURATIONS = [
  2 * MINUTE,   // 1st hit in 24h
  10 * MINUTE,  // 2nd
  HOUR,         // 3rd
  DAY,          // 4th and beyond
];

export function getNextCooldownDuration(platform: string, modelId: string, keyId: number): number {
  const key = `${platform}:${modelId}:${keyId}`;
  const now = Date.now();
  const hits = (cooldownHits.get(key) ?? []).filter(t => t > now - DAY);
  hits.push(now);
  cooldownHits.set(key, hits);
  const idx = Math.min(hits.length - 1, COOLDOWN_DURATIONS.length - 1);
  return COOLDOWN_DURATIONS[idx]!;
}

// Short cooldown for a transient (per-minute) 429 — recovers within ~one window.
const TRANSIENT_COOLDOWN_MS = 90 * 1000;

// Long cooldown for a 402 Payment Required (provider/key out of credits). Unlike
// a 429, this won't clear on the next minute/day window — it needs a top-up or
// billing reset. Bench the model+key for a full day so the router fails over to
// other providers instead of re-hammering a dead key every retry. Re-escalates
// on the next 402 after expiry if still unpaid; a restart re-benches on first hit.
export const PAYMENT_REQUIRED_COOLDOWN_MS = DAY;

// Long cooldown for a 403 Forbidden on a key that already passed validateKey
// (so it is not a dead key — the health checker disables those). A request-time
// 403 means this key's tier can't reach this specific model (e.g. gpt-4o on
// GitHub Models' free tier, subscription-only models on Cloudflare). That won't
// change within a minute window, so bench this model+key for a full day and let
// the router fail over to a model the key can actually serve. See issue #256.
export const MODEL_FORBIDDEN_COOLDOWN_MS = DAY;

// When RPD/TPD limits are NULL (provider's published daily quota is unknown or
// not yet seeded — common for ollama, cloudflare, nvidia, huggingface, mistral,
// kilo, llm7, pollinations), we cannot check a counter against a cap. Fall back
// to a hit-count heuristic: after 2+ 429s within this rolling window, treat as
// "effectively daily-exhausted" and enter the standard escalation ladder at
// the same step the documented-RPD path would. Without this, these providers
// stay stuck at TRANSIENT_COOLDOWN_MS forever even when every request is a
// 429 (observed in production: ollama 130× 429s in 1h with all 90s cooldowns
// expired before the next request). Cheaper than waiting for the operator to
// seed per-provider limits (Option A), still reversible — a successful call
// clears the hit window via the normal path.
//
// Separate counter from `cooldownHits` (used by getNextCooldownDuration's
// escalation ladder). The shared Map would make this state path-coupled to
// the ladder index, which would over-skip steps because the ladder also
// pushes a hit on each call.
const NULL_LIMIT_HIT_THRESHOLD = 2;
const NULL_LIMIT_HIT_WINDOW_MS = HOUR;
const nullLimitHits = new Map<string, number[]>(); // key -> timestamps

function recordNullLimitHit(platform: string, modelId: string, keyId: number, now: number): void {
  const key = `${platform}:${modelId}:${keyId}`;
  const hits = nullLimitHits.get(key) ?? [];
  hits.push(now);
  nullLimitHits.set(key, hits);
}

function clearNullLimitHits(platform: string, modelId: string, keyId: number): void {
  nullLimitHits.delete(`${platform}:${modelId}:${keyId}`);
}

export function recentHitCount(
  platform: string,
  modelId: string,
  keyId: number,
  now: number,
  windowMs: number = NULL_LIMIT_HIT_WINDOW_MS,
): number {
  const key = `${platform}:${modelId}:${keyId}`;
  const hits = nullLimitHits.get(key) ?? [];
  return hits.filter(t => t > now - windowMs).length;
}

// Decide how long to bench a model+key after an upstream 429. Escalate to the
// long quarantine (getNextCooldownDuration, up to 24h) when the model is at its
// DAILY limit (RPD/TPD counter ≥ cap), OR — when limits are unknown — when
// recentHitCount crosses the heuristic threshold. Either way, a long bench
// avoids hammering a truly-dead key.
//
// A transient RPM/TPM 429 with healthy daily counters gets a short fixed
// cooldown and does NOT count toward escalation. This is the common case for
// providers with a tight per-minute token budget but a large daily quota —
// e.g. groq gpt-oss-120b has rpd=1000 yet tpm=8000, so a single burst of large
// prompts 429s on TPM while the daily quota is barely touched. Daily counters
// are persisted (countPersistedRequests / sumPersistedTokens), so this verdict
// is stable across restarts.
export function getCooldownDurationForLimit(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpd: number | null; tpd: number | null },
  retryAfterMs?: number | null,
): number {
  const now = Date.now();
  const rpdExhausted =
    limits.rpd !== null && requestCount(platform, modelId, keyId, DAY, now) >= limits.rpd;
  const tpdExhausted =
    limits.tpd !== null && tokenCount(platform, modelId, keyId, DAY, now) >= limits.tpd;
  // No daily quota published → use repeated-429 heuristic: 2+ 429s in the
  // last hour is treated as effectively daily-exhausted. This unsticks
  // providers that publish no daily cap (ollama, cloudflare, etc.) from the
  // 90s-cooldown-loop without requiring operator-side limit seeding.
  const unknownLimits = limits.rpd === null && limits.tpd === null;
  let heuristicallyExhausted = false;
  if (unknownLimits) {
    // The current hit is recorded first so the threshold can be reached across
    // consecutive 429s, but only for providers where counters cannot decide.
    recordNullLimitHit(platform, modelId, keyId, now);
    heuristicallyExhausted =
      recentHitCount(platform, modelId, keyId, now) >= NULL_LIMIT_HIT_THRESHOLD;
  }
  const base = (rpdExhausted || tpdExhausted || heuristicallyExhausted)
    ? getNextCooldownDuration(platform, modelId, keyId)
    : TRANSIENT_COOLDOWN_MS;
  // Honor an upstream Retry-After as a floor: never bench shorter than our own
  // heuristic, but extend (capped at a day) when the provider explicitly asks
  // to wait longer than we otherwise would.
  if (retryAfterMs != null && retryAfterMs > base) return Math.min(retryAfterMs, DAY);
  return base;
}

function persistedCooldownExpiry(
  platform: string,
  modelId: string,
  keyId: number,
): number | null | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT expires_at_ms
        FROM rate_limit_cooldowns
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
    `).get(platform, modelId, keyId) as { expires_at_ms: number } | undefined;
    return row?.expires_at_ms ?? null;
  });
}

function persistCooldown(platform: string, modelId: string, keyId: number, expiresAtMs: number) {
  withDb(db => {
    db.prepare(`
      INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, model_id, key_id)
      DO UPDATE SET expires_at_ms = excluded.expires_at_ms
    `).run(platform, modelId, keyId, expiresAtMs);
  });
}

function clearPersistedCooldown(platform: string, modelId: string, keyId: number) {
  withDb(db => {
    db.prepare(`
      DELETE FROM rate_limit_cooldowns
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
    `).run(platform, modelId, keyId);
  });
}

export function setCooldown(platform: string, modelId: string, keyId: number, durationMs = 60_000) {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const expiresAtMs = Date.now() + durationMs;
  cooldowns.set(key, expiresAtMs);
  persistCooldown(platform, modelId, keyId, expiresAtMs);
}

export function isOnCooldown(platform: string, modelId: string, keyId: number): boolean {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const now = Date.now();
  const persistedExpiry = persistedCooldownExpiry(platform, modelId, keyId);
  if (persistedExpiry !== undefined && persistedExpiry !== null) {
    if (now > persistedExpiry) {
      cooldowns.delete(key);
      clearPersistedCooldown(platform, modelId, keyId);
      return false;
    }
    cooldowns.set(key, persistedExpiry);
    return true;
  }

  const expiry = cooldowns.get(key);
  if (!expiry) return false;
  if (now > expiry) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

export interface ActiveCooldown {
  platform: string;
  modelId: string;
  keyId: number;
  expiresAtMs: number;
  remainingMs: number;
}

/**
 * Active cooldowns for the given keys, grouped by key id. Batched into one query
 * so the dashboard can render "why is this key idle?" without N round-trips.
 * Without this, a key benched by an escalated cooldown (up to 24h) is invisible:
 * it reads as healthy and enabled while the router silently skips it.
 */
export function getActiveCooldownsForKeys(
  keyIds: number[],
  now = Date.now(),
): Map<number, ActiveCooldown[]> {
  const grouped = new Map<number, ActiveCooldown[]>();
  if (keyIds.length === 0) return grouped;

  const unique = [...new Set(keyIds.filter(id => Number.isInteger(id)))];
  if (unique.length === 0) return grouped;

  const placeholders = unique.map(() => '?').join(', ');
  const rows = withDb(db => db.prepare(`
    SELECT platform, model_id, key_id, expires_at_ms
      FROM rate_limit_cooldowns
     WHERE expires_at_ms > ?
       AND key_id IN (${placeholders})
     ORDER BY expires_at_ms ASC
  `).all(now, ...unique) as { platform: string; model_id: string; key_id: number; expires_at_ms: number }[]) ?? [];

  for (const row of rows) {
    const list = grouped.get(row.key_id) ?? [];
    list.push({
      platform: row.platform,
      modelId: row.model_id,
      keyId: row.key_id,
      expiresAtMs: row.expires_at_ms,
      remainingMs: Math.max(0, row.expires_at_ms - now),
    });
    grouped.set(row.key_id, list);
  }
  return grouped;
}

/**
 * Drop every cooldown for one key, in memory and on disk, and return how many
 * were cleared. Escalated cooldowns can bench a key for up to 24h off a single
 * bad window; an operator who has fixed the cause (raised a quota, waited out a
 * provider incident) otherwise has no way back except restarting and waiting.
 */
export function clearCooldownsForKey(keyId: number): number {
  if (!Number.isInteger(keyId)) return 0;

  const cleared = withDb(db => {
    const result = db.prepare('DELETE FROM rate_limit_cooldowns WHERE key_id = ?').run(keyId);
    return Number(result.changes ?? 0);
  }) ?? 0;

  // The in-memory map is authoritative when the DB read fails, so purge it too.
  // Key format is "platform:modelId:keyId:cooldown" and modelId may contain ':',
  // so match on the trailing segments rather than splitting.
  const suffix = `:${keyId}:cooldown`;
  let memoryCleared = 0;
  for (const key of [...cooldowns.keys()]) {
    if (key.endsWith(suffix)) {
      cooldowns.delete(key);
      cooldownHits.delete(key.slice(0, -':cooldown'.length));
      memoryCleared++;
    }
  }

  return Math.max(cleared, memoryCleared);
}

/**
 * Soonest moment any active cooldown expires, in ms since epoch, or null when
 * nothing is cooling down. Used to tell an exhausted caller roughly when to
 * retry (#423) instead of the bare "wait for rate limits to reset".
 */
export function getSoonestCooldownExpiry(now = Date.now()): number | null {
  return withDb(db => {
    const row = db.prepare(`
      SELECT MIN(expires_at_ms) AS soonest
        FROM rate_limit_cooldowns
       WHERE expires_at_ms > ?
    `).get(now) as { soonest: number | null } | undefined;
    return row?.soonest ?? null;
  }) ?? null;
}

export function getRateLimitStatus(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
) {
  const now = Date.now();

  return {
    rpm: { used: requestCount(platform, modelId, keyId, MINUTE, now), limit: limits.rpm },
    rpd: { used: requestCount(platform, modelId, keyId, DAY, now), limit: limits.rpd },
    tpm: { used: tokenCount(platform, modelId, keyId, MINUTE, now), limit: limits.tpm },
  };
}

// ── Learning real provider limits from error bodies (self-correcting catalog) ──
// Free-tier limits drift and our seeded catalog is frequently wrong or null.
// When a provider rejects a request with its real limit in the body — Groq 413:
// "...on tokens per minute (TPM): Limit 30000, Requested 33476" — we can learn
// that ceiling and persist it so the canUseTokens / canMakeRequest pre-checks
// stop us BEFORE the next 413 instead of re-discovering it on every request.
// (Fork-validated: andersmmg's updateLimitsFromError parses the same Groq shape.)

export type LearnedLimitKind = 'tpm' | 'tpd' | 'rpm' | 'rpd';
export interface LearnedLimit { kind: LearnedLimitKind; limit: number; }

// Order matters: check the per-DAY axes before per-MINUTE so "tokens per day"
// isn't shadowed by the "tpm" word-boundary alternative, and tokens before
// requests so a body mentioning both lands on the more specific token ceiling.
const LIMIT_AXIS_PATTERNS: Array<{ kind: LearnedLimitKind; re: RegExp }> = [
  { kind: 'tpd', re: /tokens?\s*per\s*day|\btpd\b/i },
  { kind: 'tpm', re: /tokens?\s*per\s*min(?:ute)?|\btpm\b/i },
  { kind: 'rpd', re: /requests?\s*per\s*day|\brpd\b/i },
  { kind: 'rpm', re: /requests?\s*per\s*min(?:ute)?|\brpm\b/i },
];

/**
 * Pure parser: pull a provider-reported ceiling out of an error message. Returns
 * null unless BOTH a numeric "Limit N" and a confident axis (TPM/TPD/RPM/RPD)
 * are present — guessing the axis would write the wrong column and mis-route
 * every future request, so we refuse to guess.
 */
export function parseProviderLimit(message: string | undefined | null): LearnedLimit | null {
  if (!message) return null;
  const m = message.match(/\blimit[:\s]+([\d,]+)/i);
  if (!m) return null;
  const limit = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(limit) || limit <= 0) return null;
  for (const { kind, re } of LIMIT_AXIS_PATTERNS) {
    if (re.test(message)) return { kind, limit };
  }
  return null;
}

// Whitelisted column names — the only values ever interpolated into the UPDATE
// below, so there is no injection surface despite the template literal.
const LIMIT_COLUMN: Record<LearnedLimitKind, string> = {
  tpm: 'tpm_limit', tpd: 'tpd_limit', rpm: 'rpm_limit', rpd: 'rpd_limit',
};

/**
 * Persist a provider-reported limit onto the model row, but ONLY when it makes
 * us more conservative: fill a NULL (unknown) limit, or LOWER an existing one
 * that was too high. Never raises a limit — hitting a ceiling means our pre-check
 * already let too much through, so the true limit is at or below what we used.
 * Returns the learned limit when a row was actually changed, else null.
 * DB-guarded (no-op when the DB is unavailable), like the rest of this module.
 */
export function learnLimitFromError(modelDbId: number, err: { message?: string }): LearnedLimit | null {
  const parsed = parseProviderLimit(err?.message);
  if (!parsed) return null;
  const col = LIMIT_COLUMN[parsed.kind];
  const result = withDb(db =>
    db.prepare(
      `UPDATE models SET ${col} = ? WHERE id = ? AND (${col} IS NULL OR ${col} > ?)`,
    ).run(parsed.limit, modelDbId, parsed.limit),
  );
  return result && result.changes > 0 ? parsed : null;
}
