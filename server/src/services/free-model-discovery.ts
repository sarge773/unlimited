/**
 * free-model-discovery — keeps the cloud-fallback tier populated with the
 * latest free models from openrouter, tokenrouter, and any other provider
 * that publishes a way to identify free models.
 *
 * Two source rules, by provider:
 *
 *   openrouter  — provider's /v1/models returns a `pricing.prompt` field;
 *                 "free" is `pricing.prompt === "0"`. The `:free` suffix on
 *                 the slug is the *human-readable* signal. We use the
 *                 pricing field as the source of truth because it's
 *                 machine-verifiable and survives any future renames.
 *
 *   tokenrouter — provider's /v1/models returns NO pricing field. "Free" is
 *                 purely a UI badge. The discovery service reads the
 *                 `cloud_provider_free_models` allowlist table and treats
 *                 every entry as a candidate. New free models require a
 *                 one-line addition to the allowlist (via the dashboard or
 *                 a probe-and-verify POST to /api/fallback/cloud/free-models).
 *
 *   future      — register a new branch in `fetchLiveFreeModels` per
 *                 provider. The rest of the pipeline is provider-agnostic.
 *
 * Side effects per refresh:
 *   - INSERT new (platform, model_id) into `models` with conservative defaults
 *     (intelligence_rank 999, size_label 'Medium', 20 RPM, 200 RPD).
 *   - INSERT new rows into `cloud_fallback_config` at the tail of the chain
 *     (MAX(priority) + 1). auto_managed=1.
 *   - UPDATE rows in `cloud_fallback_config` WHERE auto_managed=1 AND the
 *     model is no longer in the live free list, set enabled=0. The row is
 *     kept (not deleted) so analytics can still see "this model used to be
 *     in the chain" and the user can re-enable manually if they disagree
 *     with the discovery.
 *
 * The refresh runs at boot (after a 10s delay) and every 12 hours, matching
 * the catalog-sync cadence. Errors are caught and logged; a failing refresh
 * does NOT crash the server or block startup.
 *
 * Per-request `currentChain` already filters by `enabled=1`, so a model that
 * gets disabled by this service is silently removed from the cloud chain
 * until the user re-enables it.
 */

import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import type DatabaseType from 'better-sqlite3';

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
const BOOT_DELAY_MS = 10 * 1000;                  // 10s after boot
const FETCH_TIMEOUT_MS = 15 * 1000;               // 15s per provider

export interface DiscoveryResult {
  scanned: Record<string, number>;  // platform -> number of free models found in live API
  added:   Array<{ platform: string; model_id: string }>;  // newly added
  retired: Array<{ platform: string; model_id: string; reason: string }>;
  errors:  Array<{ platform: string; message: string }>;
  durationMs: number;
}

interface LiveFreeModel {
  platform: string;
  model_id: string;
  // Best-effort metadata from the provider's response. Defaults applied if
  // missing (so the model is usable even when the API is sparse).
  display_name?: string;
  context_window?: number;
  size_label?: string;       // 'Small' | 'Medium' | 'Large' | 'Frontier'
  intelligence_rank?: number; // 1 = best, higher = weaker
  supports_vision?: boolean;
  supports_tools?: boolean;
}

// ── Live API fetchers (per provider) ──────────────────────────────────────

interface KeyRow {
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

function getApiKey(platform: string): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT encrypted_key, iv, auth_tag FROM api_keys
    WHERE platform = ? AND enabled = 1
    ORDER BY id ASC LIMIT 1
  `).get(platform) as KeyRow | undefined;
  if (!row) return null;
  try {
    return decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    return null;
  }
}

async function fetchOpenRouterFreeModels(): Promise<LiveFreeModel[]> {
  const key = getApiKey('openrouter');
  if (!key) throw new Error('no enabled openrouter api_key in api_keys table');

  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'Authorization': `Bearer ${key}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`openrouter /v1/models HTTP ${res.status}`);
  const json = await res.json() as { data?: Array<Record<string, unknown>> };
  const rows = json.data || [];
  const out: LiveFreeModel[] = [];
  for (const m of rows) {
    const id = String(m.id || '');
    if (!id) continue;
    // The source of truth is the pricing field, not the slug suffix — the
    // suffix is a UX convention the catalog team uses; the API is what we
    // can machine-verify.
    const pricing = (m.pricing as { prompt?: string; completion?: string } | undefined) || {};
    const promptFree = pricing.prompt === '0' || pricing.prompt === '0.0';
    const completionFree = pricing.completion === '0' || pricing.completion === '0.0';
    if (!promptFree || !completionFree) continue;
    const arch = (m.architecture as { modality?: string } | undefined) || {};
    const modality = arch.modality || 'text->text';
    out.push({
      platform: 'openrouter',
      model_id: id,
      display_name: String(m.name || id),
      context_window: typeof m.context_length === 'number' ? m.context_length : 131072,
      // Heuristic size label based on context window — OpenRouter doesn't
      // publish a size_label the way our catalog does, and we don't want
      // every :free model to sort as "Medium" by default.
      size_label: heuristicSizeLabel(id, Number(m.context_length || 0)),
      intelligence_rank: heuristicIntelligenceRank(id),
      supports_vision: modality.includes('image'),
      supports_tools: true, // all :free openrouter models in 2026 support tools
    });
  }
  return out;
}

async function fetchTokenRouterFreeModels(): Promise<LiveFreeModel[]> {
  // No API hint. Read the allowlist table — the user (or a previous
  // successful probe) has confirmed these are callable for free. We still
  // call /v1/models to make sure the slug still exists upstream (the
  // provider can retire a model at any time).
  const db = getDb();
  const allow = db.prepare(`
    SELECT model_id, notes FROM cloud_provider_free_models
    WHERE platform = 'tokenrouter'
    ORDER BY added_at ASC
  `).all() as Array<{ model_id: string; notes: string | null }>;

  if (allow.length === 0) return [];

  // Verify each allowlisted slug is still in tokenrouter's catalog. This
  // catches the "retired upstream" case without a real probe (which would
  // cost 1 free request per model — prohibitive at scale).
  const key = getApiKey('tokenrouter');
  if (!key) {
    // No key configured — fall back to "trust the allowlist" so the user
    // can still see what they manually added. The proxy will 401/403 at
    // request time if the key is wrong.
    return allow.map(a => ({
      platform: 'tokenrouter',
      model_id: a.model_id,
      display_name: a.model_id,
      context_window: 131072,
      size_label: 'Large',
      intelligence_rank: 999,
      supports_vision: false,
      supports_tools: true,
    }));
  }

  const res = await fetch('https://api.tokenrouter.com/v1/models', {
    headers: { 'Authorization': `Bearer ${key}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Transient failure — don't penalize the user. Trust the allowlist
    // for this refresh; the next one (12h later) will retry.
    console.warn(`[free-model-discovery] tokenrouter /v1/models HTTP ${res.status}, trusting allowlist`);
    return allow.map(a => ({
      platform: 'tokenrouter',
      model_id: a.model_id,
      display_name: a.model_id,
      context_window: 131072,
      size_label: 'Large',
      intelligence_rank: 999,
      supports_vision: false,
      supports_tools: true,
    }));
  }
  const json = await res.json() as { data?: Array<Record<string, unknown>> };
  const liveIds = new Set((json.data || []).map(m => String(m.id || '')));

  return allow
    .filter(a => liveIds.has(a.model_id))
    .map(a => ({
      platform: 'tokenrouter',
      model_id: a.model_id,
      display_name: a.model_id,
      context_window: 131072,
      size_label: 'Large',
      intelligence_rank: 999,
      supports_vision: false,
      supports_tools: true,
    }));
}

async function fetchLiveFreeModels(platform: string): Promise<LiveFreeModel[]> {
  if (platform === 'openrouter') return fetchOpenRouterFreeModels();
  if (platform === 'tokenrouter') return fetchTokenRouterFreeModels();
  throw new Error(`free-model-discovery: no fetcher for platform "${platform}"`);
}

// ── Heuristics for sparse APIs (tokenrouter, future providers) ────────────

function heuristicSizeLabel(modelId: string, contextWindow: number): string {
  const m = modelId.toLowerCase();
  if (m.includes('405b') || m.includes('120b') || m.includes('ultra') || m.includes('frontier') || m.includes('hermes-3-llama-3.1-405b')) return 'Frontier';
  if (m.includes('70b') || m.includes('80b') || m.includes('super') || m.includes('xl') || m.includes('large')) return 'Large';
  if (m.includes('mini') || m.includes('nano') || m.includes('small') || m.includes('1b') || m.includes('2b') || m.includes('3b')) return 'Small';
  if (contextWindow >= 200_000) return 'Large';
  if (contextWindow >= 60_000) return 'Medium';
  return 'Medium';
}

function heuristicIntelligenceRank(modelId: string): number {
  const m = modelId.toLowerCase();
  if (m.includes('405b') || m.includes('frontier')) return 1;
  if (m.includes('120b') || m.includes('ultra') || m.includes('super')) return 2;
  if (m.includes('80b') || m.includes('70b')) return 3;
  if (m.includes('large')) return 4;
  if (m.includes('xl')) return 5;
  if (m.includes('gpt-oss-120b')) return 5;
  if (m.includes('gpt-oss-20b')) return 11;
  if (m.includes('coder')) return 9;
  if (m.includes('mini') || m.includes('nano')) return 13;
  if (m.includes('1b') || m.includes('2b')) return 30;
  return 999;
}

// ── Diff + apply (the part that touches the DB) ──────────────────────────

function applyDiff(live: LiveFreeModel[], platform: string): { added: Array<{ platform: string; model_id: string }>; retired: Array<{ platform: string; model_id: string; reason: string }> } {
  const db = getDb();
  const added: Array<{ platform: string; model_id: string }> = [];
  const retired: Array<{ platform: string; model_id: string; reason: string }> = [];

  // Pre-compute the live set (for the "retired" pass).
  const liveIds = new Set(live.map(m => m.model_id));

  const apply = db.transaction(() => {
    // Pass 1: add new (platform, model_id) pairs.
    const insertModel = db.prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, supports_vision, supports_tools)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '~6M', ?, ?, ?)
    `);
    const fillNulls = db.prepare(`
      UPDATE models SET
        context_window = COALESCE(context_window, ?),
        size_label = CASE WHEN size_label = '' THEN ? ELSE size_label END
      WHERE platform = ? AND model_id = ?
    `);
    const maxPriority = (db.prepare(`SELECT COALESCE(MAX(priority), 0) AS m FROM cloud_fallback_config`).get() as { m: number }).m;
    let nextPriority = maxPriority + 1;
    const insertCfc = db.prepare(`
      INSERT OR IGNORE INTO cloud_fallback_config (model_db_id, priority, enabled, auto_managed)
      VALUES (?, ?, 1, 1)
    `);
    for (const m of live) {
      const r = insertModel.run(
   m.platform, m.model_id,
   m.display_name || m.model_id,
   m.intelligence_rank ?? 999,
   7, // speed_rank — conservative default; user can re-sort from the dashboard
   m.size_label || 'Medium',
   20, // rpm_limit
   200, // rpd_limit
   m.context_window ?? 131072,
   m.supports_vision ? 1 : 0,
   m.supports_tools !== false ? 1 : 0,
 );
      fillNulls.run(m.context_window ?? 131072, m.size_label || 'Medium', m.platform, m.model_id);
      const row = db.prepare(`SELECT id FROM models WHERE platform = ? AND model_id = ?`).get(m.platform, m.model_id) as { id: number } | undefined;
      if (!row) continue;
      const cfcExists = db.prepare(`SELECT id FROM cloud_fallback_config WHERE model_db_id = ?`).get(row.id) as { id: number } | undefined;
      if (!cfcExists) {
        insertCfc.run(row.id, nextPriority);
        added.push({ platform: m.platform, model_id: m.model_id });
        nextPriority++;
      }
    }

    // Pass 2: disable cloud_fallback_config rows where auto_managed=1 AND
    // the model is no longer in the live list. (Don't hard-delete; the user
    // might want to re-enable manually if the discovery is wrong.)
    const stale = db.prepare(`
      SELECT cfc.id, m.platform, m.model_id
      FROM cloud_fallback_config cfc
      JOIN models m ON m.id = cfc.model_db_id
      WHERE cfc.auto_managed = 1
        AND cfc.enabled = 1
        AND m.platform = ?
    `).all(platform) as Array<{ id: number; platform: string; model_id: string }>;
    const disable = db.prepare(`UPDATE cloud_fallback_config SET enabled = 0 WHERE id = ?`);
    for (const s of stale) {
      if (!liveIds.has(s.model_id)) {
        disable.run(s.id);
        retired.push({ platform: s.platform, model_id: s.model_id, reason: 'no longer in provider free list' });
      }
    }
  });
  apply();
  return { added, retired };
}

// ── Public entrypoints ──────────────────────────────────────────────────

export async function refreshFreeModels(platforms: string[] = ['openrouter', 'tokenrouter']): Promise<DiscoveryResult> {
  const t0 = Date.now();
  const result: DiscoveryResult = {
    scanned: {},
    added: [],
    retired: [],
    errors: [],
    durationMs: 0,
  };
  for (const p of platforms) {
    try {
      const live = await fetchLiveFreeModels(p);
      result.scanned[p] = live.length;
      // Pass the platform explicitly so the retire query inside applyDiff
      // is scoped to this platform only (avoids touching other platforms'
      // auto_managed rows in the same call).
      const { added, retired } = applyDiff(live, p);
      result.added.push(...added);
      result.retired.push(...retired);
      if (added.length > 0 || retired.length > 0) {
        console.log(`[free-model-discovery] ${p}: +${added.length} added, -${retired.length} retired (${live.length} live free models)`);
      } else {
        console.log(`[free-model-discovery] ${p}: no change (${live.length} live free models)`);
      }
    } catch (e: any) {
      const message = e?.message || String(e);
      result.errors.push({ platform: p, message });
      console.warn(`[free-model-discovery] ${p}: error — ${message}`);
    }
  }
  result.durationMs = Date.now() - t0;
  return result;
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;

export function startFreeModelDiscovery(): void {
  if (intervalId || bootTimer) return;
  // Same 10s boot delay as catalog-sync — gives the server time to settle
  // (api_keys, db, providers) before any outbound fetches.
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void refreshFreeModels().catch(err => {
      console.error('[free-model-discovery] boot refresh failed:', err?.message || err);
    });
  }, BOOT_DELAY_MS);
  intervalId = setInterval(() => {
    void refreshFreeModels().catch(err => {
      console.error('[free-model-discovery] interval refresh failed:', err?.message || err);
    });
  }, REFRESH_INTERVAL_MS);
  console.log(`[free-model-discovery] scheduled (boot in ${BOOT_DELAY_MS/1000}s, interval ${REFRESH_INTERVAL_MS/3600000}h)`);
}

export function stopFreeModelDiscovery(): void {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
}
