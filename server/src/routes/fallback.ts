/**
 * Express router handles model fallback configuration and token budget reporting.
 * It integrates named profiles dynamically into the fallback routing logic and aggregates
 * monthly token consumption and rate limits (RPM/RPD/TPM/TPD) across configured models.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getAllPenalties, getRoutingScores, getRoutingStrategy, setRoutingStrategy, setCustomWeights } from '../services/router.js';
import { getRecentEvents, getStats, purgeOldEvents } from '../services/fallback-logger.js';
import { breaker } from '../services/breaker.js';
import { BANDIT_PRESETS, type RoutingStrategy } from '../services/scoring.js';
import { parseBudget } from '../lib/budget.js';
export const fallbackRouter = Router();

// `intelligence_rank` is scoped to each provider's own catalog — a provider's
// #1 model is not globally #1 (see issue #135: MiniMax's top model outranking
// Gemini Pro because both read "Intel #1"). `size_label` IS a cross-provider
// capability tier, so normalize on it first and use intelligence_rank only as
// an in-tier tiebreaker. Unknown labels sort last.
const INTELLIGENCE_TIER =
  "CASE m.size_label WHEN 'Frontier' THEN 1 WHEN 'Large' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Small' THEN 4 ELSE 5 END";

// Sort presets — `orderBy` is selected from a fixed whitelist, never from
// user input directly, so the interpolation below is safe.
const SORT_PRESETS: Record<string, string> = {
  intelligence: `${INTELLIGENCE_TIER} ASC, m.intelligence_rank ASC`,
  speed: 'm.speed_rank ASC',
};

function getBudgetScore(m: { monthly_token_budget: string; tpd_limit: number | null }): number {
  if (m.tpd_limit != null) return m.tpd_limit * 30;

  const str = m.monthly_token_budget;
  if (!str) return 0;
  if (str.toLowerCase().includes('unlimited') || str.includes('∞')) return Infinity;

  const cleanStr = str.split('(')[0];
  const matches = cleanStr.match(/[\d.]+/g);
  let maxNum = 0;
  if (matches) {
    maxNum = Math.max(...matches.map(mStr => parseFloat(mStr)));
  }

  let mult = 1;
  const upper = cleanStr.toUpperCase();
  if (upper.includes('B')) mult = 1_000_000_000;
  else if (upper.includes('M')) mult = 1_000_000;
  else if (upper.includes('K')) mult = 1_000;

  return maxNum * mult;
}

// ── Bandit routing strategy ─────────────────────────────────────────────────
// GET  /routing → active strategy, preset weights, and the per-model score
//                 breakdown (reliability / speed / intelligence + guardrails).
fallbackRouter.get('/routing', (_req: Request, res: Response) => {
  res.json(getRoutingScores());
});

const routingSchema = z.object({
  strategy: z.enum(['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom']),
  // Only meaningful with strategy 'custom': the user's weight vector. Any
  // non-negative vector is accepted; setCustomWeights renormalizes to sum 1.
  weights: z.object({
    reliability: z.number().nonnegative(),
    speed: z.number().nonnegative(),
    intelligence: z.number().nonnegative(),
  }).optional(),
});

// PUT /routing → switch strategy. Presets are just weight vectors over the three
// axes; 'priority' falls back to the legacy manual chain order; 'custom' uses
// the user's saved weights (optionally updated in the same request).
fallbackRouter.put('/routing', (req: Request, res: Response) => {
  const parsed = routingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  // Persist the weights before flipping the strategy so the new mode reads the
  // intended vector immediately. setCustomWeights throws on an all-zero vector.
  if (parsed.data.weights) {
    try {
      setCustomWeights(parsed.data.weights);
    } catch (err: any) {
      res.status(400).json({ error: { message: err?.message ?? 'Invalid custom weights' } });
      return;
    }
  }
  setRoutingStrategy(parsed.data.strategy as RoutingStrategy);
  res.json({ strategy: getRoutingStrategy(), presets: BANDIT_PRESETS });
});

// Get fallback chain (with dynamic penalties)
fallbackRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.tpm_limit, m.tpd_limit,
           m.monthly_token_budget, m.supports_vision, m.supports_tools
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE m.enabled = 1
    ORDER BY fc.priority ASC
  `).all() as any[];

  // Count enabled keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];
  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  // Get current dynamic penalties
  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

  res.json(rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    return {
      modelDbId: r.model_db_id,
      priority: r.priority,
      effectivePriority: r.priority + (penalty?.penalty ?? 0),
      penalty: penalty?.penalty ?? 0,
      rateLimitHits: penalty?.count ?? 0,
      enabled: r.enabled === 1,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.intelligence_rank,
      speedRank: r.speed_rank,
      sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      tpmLimit: r.tpm_limit,
      tpdLimit: r.tpd_limit,
      monthlyTokenBudget: r.monthly_token_budget,
      supportsVision: r.supports_vision === 1,
      supportsTools: r.supports_tools === 1,
      keyCount: keyCountMap.get(r.platform) ?? 0,
    };
  }));
});

const updateSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

// Update fallback chain (full replace)
fallbackRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const update = db.prepare(`
    UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?
  `);

  const updateAll = db.transaction(() => {
    for (const entry of parsed.data) {
      update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
    }
  });
  updateAll();

  res.json({ success: true });
});

// ── Cloud-fallback chain (Phase 2) ─────────────────────────────────────────
// The proxy only consults this chain when the local chain is exhausted
// (see proxy.ts). Keeping the routes nested under /api/fallback/cloud
// mirrors the existing surface and makes the dashboard a one-page addition.

fallbackRouter.get('/cloud', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT cfc.model_db_id, cfc.priority, cfc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.tpm_limit, m.tpd_limit,
           m.monthly_token_budget, m.supports_vision, m.supports_tools
    FROM cloud_fallback_config cfc
    JOIN models m ON m.id = cfc.model_db_id
    WHERE m.enabled = 1
    ORDER BY cfc.priority ASC
  `).all() as any[];

  // Count enabled keys per platform (so the dashboard can show "no key
  // configured" warnings on cloud rows — same UX as the local chain).
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];
  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  res.json(rows.map(r => ({
    modelDbId: r.model_db_id,
    priority: r.priority,
    enabled: r.enabled === 1,
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name,
    intelligenceRank: r.intelligence_rank,
    speedRank: r.speed_rank,
    sizeLabel: r.size_label,
    rpmLimit: r.rpm_limit,
    rpdLimit: r.rpd_limit,
    tpmLimit: r.tpm_limit,
    tpdLimit: r.tpd_limit,
    monthlyTokenBudget: r.monthly_token_budget,
    supportsVision: r.supports_vision === 1,
    supportsTools: r.supports_tools === 1,
    keyCount: keyCountMap.get(r.platform) ?? 0,
  })));
});

const cloudUpdateSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

fallbackRouter.put('/cloud', (req: Request, res: Response) => {
  const parsed = cloudUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  // Full-replace semantics match PUT /api/fallback. The dashboard sends the
  // whole desired chain; rows missing from the request are removed.
  const upsert = db.prepare(`
    INSERT INTO cloud_fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)
    ON CONFLICT(model_db_id) DO UPDATE SET priority = excluded.priority, enabled = excluded.enabled
  `);
  const remove = db.prepare(`DELETE FROM cloud_fallback_config WHERE model_db_id NOT IN (${parsed.data.map(() => '?').join(',') || 'NULL'})`);
  const applyAll = db.transaction(() => {
    for (const entry of parsed.data) {
      upsert.run(entry.modelDbId, entry.priority, entry.enabled ? 1 : 0);
    }
    if (parsed.data.length > 0) {
      remove.run(...parsed.data.map(e => e.modelDbId));
    } else {
      // Empty chain: clear everything
      db.prepare(`DELETE FROM cloud_fallback_config`).run();
    }
  });
  applyAll();

  // Touch update to keep the API consistent with /api/fallback (the row
  // metadata we returned is now stale).
  res.json({ success: true });
});

// Auto-sort presets (mirror the local /api/fallback/sort/:preset endpoints).
// Cloud models are usually a small set, so this is mostly a "first time
// setup" affordance — the dashboard uses it once, then the user fine-tunes
// via drag-to-reorder.
const CLOUD_SORT_PRESETS: Record<string, string> = {
  intelligence: `${INTELLIGENCE_TIER} ASC, m.intelligence_rank ASC`,
  speed: 'm.speed_rank ASC',
};

fallbackRouter.get('/cloud/free-models', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT platform, model_id, added_at, probe_verified, notes
    FROM cloud_provider_free_models
    ORDER BY platform ASC, added_at ASC
  `).all() as any[];
  res.json(rows.map(r => ({
    platform: r.platform,
    modelId: r.model_id,
    addedAt: r.added_at,
    probeVerified: r.probe_verified === 1,
    notes: r.notes,
  })));
});

const freeModelAddSchema = z.object({
  platform: z.string().min(1),
  modelId: z.string().min(1),
  notes: z.string().optional(),
  probe: z.boolean().optional(), // default true — make a small request to confirm the model is free
});

fallbackRouter.post('/cloud/free-models', async (req: Request, res: Response) => {
  const parsed = freeModelAddSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { platform, modelId, notes, probe = true } = parsed.data;
  const db = getDb();
  // Idempotent insert; on conflict, refresh the notes/probe_verified fields.
  const existing = db.prepare(`SELECT notes, probe_verified FROM cloud_provider_free_models WHERE platform = ? AND model_id = ?`).get(platform, modelId) as { notes: string | null; probe_verified: number } | undefined;

  let probeVerified = 0;
  let probeBody: any = null;
  if (probe) {
    const k = db.prepare(`SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = 1 ORDER BY id ASC LIMIT 1`).get(platform) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
    if (!k) {
      res.status(409).json({ error: { message: `no enabled api_key for platform "${platform}" — add a key first, then probe` } });
      return;
    }
    const { decrypt } = await import('../lib/crypto.js');
    const apiKey = decrypt(k.encrypted_key, k.iv, k.auth_tag);
    // Platform base URL
    const baseUrl = platform === 'openrouter' ? 'https://openrouter.ai/api/v1'
                   : platform === 'tokenrouter' ? 'https://api.tokenrouter.com/v1'
                   : null;
    if (!baseUrl) {
      res.status(400).json({ error: { message: `probe not supported for platform "${platform}"` } });
      return;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const probeRes = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!probeRes.ok) {
        res.status(502).json({ error: { message: `probe failed: HTTP ${probeRes.status}`, status: probeRes.status } });
        return;
      }
      probeBody = await probeRes.json().catch(() => null);
      // Tokenrouter doesn't return a pricing field; the probe just confirms
      // the model exists. We mark it verified if the response has at least
      // one choice (non-empty completion).
      if (probeBody && Array.isArray(probeBody.choices) && probeBody.choices.length > 0) {
        probeVerified = 1;
      }
    } catch (e: any) {
      res.status(502).json({ error: { message: `probe error: ${e?.message || e}` } });
      return;
    }
  }

  const finalNotes = notes || existing?.notes || null;
  if (existing) {
    db.prepare(`
      UPDATE cloud_provider_free_models
      SET probe_verified = ?, notes = ?
      WHERE platform = ? AND model_id = ?
    `).run(probeVerified, finalNotes, platform, modelId);
  } else {
    db.prepare(`
      INSERT INTO cloud_provider_free_models (platform, model_id, probe_verified, notes)
      VALUES (?, ?, ?, ?)
    `).run(platform, modelId, probeVerified, finalNotes);
  }

  // Trigger an immediate refresh so the model is in the cloud chain right
  // away (the user can also wait for the next 12h cycle). The refresh is
  // async and the response doesn't wait for it.
  void import('../services/free-model-discovery.js').then(m => m.refreshFreeModels([platform])).catch(err => {
    console.error('[fallback/cloud/free-models POST] post-add refresh failed:', err);
  });

  res.json({ success: true, platform, modelId, probeVerified: probeVerified === 1 });
});

fallbackRouter.delete('/cloud/free-models/:platform/:model_id', (req: Request, res: Response) => {
  const platform = String(req.params.platform);
  const modelId = decodeURIComponent(String(req.params.model_id));
  const db = getDb();
  // Remove the allowlist row. The discovery service's next refresh will
  // also disable any auto_managed cloud_fallback_config entries for this
  // (platform, model_id). We do not touch manually-added cloud chain rows.
  const result = db.prepare(`
    DELETE FROM cloud_provider_free_models
    WHERE platform = ? AND model_id = ?
  `).run(platform, modelId);
  // Force a refresh so the chain reflects the removal.
  void import('../services/free-model-discovery.js').then(m => m.refreshFreeModels([platform])).catch(err => {
    console.error('[fallback/cloud/free-models DELETE] post-remove refresh failed:', err);
  });
  res.json({ success: true, removed: result.changes });
});

fallbackRouter.post('/cloud/refresh', async (_req: Request, res: Response) => {
  // Manual trigger of the discovery service (useful for "I just added a free
  // model to the allowlist, don't make me wait 12h").
  const { refreshFreeModels } = await import('../services/free-model-discovery.js');
  try {
    const result = await refreshFreeModels();
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: { message: e?.message || 'refresh failed' } });
  }
});

// ── Phase 4: observability endpoints ─────────────────────────────────────

fallbackRouter.get('/events', (req: Request, res: Response) => {
  // Default 200 events; the dashboard "Fallback activity" panel renders
  // the last ~50 but asks for 200 so scrolling doesn't need a refetch.
  // Cap at 2000 to keep the JSON payload small.
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1), 2000);
  const platform = req.query.platform ? String(req.query.platform) : undefined;
  const outcome = req.query.outcome ? String(req.query.outcome) : undefined;
  const sinceMs = req.query.sinceMs ? parseInt(String(req.query.sinceMs), 10) : undefined;
  const events = getRecentEvents({ limit, platform, outcome: outcome as any, sinceMs });
  // getRecentEvents returns raw SQL rows (snake_case). The dashboard
  // expects camelCase; this map is the single conversion point. Any new
  // field must be mapped here too.
  res.json(events.map(e => ({
    id: e.id,
    requestId: e.request_id,
    tier: e.tier,
    platform: e.platform,
    model: e.model,
    outcome: e.outcome,
    latencyMs: e.latency_ms,
    reason: e.reason,
    createdAt: e.created_at,
  })));
});

fallbackRouter.get('/stats', (req: Request, res: Response) => {
  // Default 1h window. The dashboard "Health" tab uses ?windowMs=3600000;
  // a longer window (e.g. 24h) is available for a "Last 24 hours" view.
  const windowMs = Math.min(
    Math.max(parseInt(String(req.query.windowMs ?? '3600000'), 10) || 3600000, 60_000),
    7 * 24 * 60 * 60 * 1000, // cap at 7 days
  );
  res.json(getStats(windowMs));
});

fallbackRouter.get('/breakers', (_req: Request, res: Response) => {
  // Read-only view of the in-memory breaker state for the dashboard.
  // Returns [{ platform, state, ...snapshot }] so the dashboard can label
  // each card. The platforms list is the same one the discovery service
  // watches (Phase 2.5) — keeps the two surfaces in sync.
  const platforms = ['openrouter', 'tokenrouter'];
  res.json(platforms.map(p => ({ platform: p, ...breaker.snapshot(p as any) })));
});

fallbackRouter.post('/events/purge', (req: Request, res: Response) => {
  // Manual retention prune. Default 7 days; the same default the boot
  // job uses.
  const maxAgeDays = Math.min(Math.max(parseInt(String(req.query.maxAgeDays ?? '7'), 10) || 7, 1), 30);
  const removed = purgeOldEvents(maxAgeDays);
  res.json({ success: true, removed });
});

// ── Phase 5: breaker test endpoints ──────────────────────────────────────
//
// These exist to let you (or the smoke tests) demonstrate the breaker
// behavior without having to actually cause 3 consecutive 5xx responses
// from a provider. Useful for:
//   - verifying the dashboard renders the breaker card correctly
//   - confirming the proxy skips the open platform on the next request
//   - QA-ing the half-open probe transition
//
// In production these are no-ops for normal users — but they're left
// unprotected because the rest of the dashboard admin surface requires
// session auth, which is enough gatekeeping for a single-user local tool.

fallbackRouter.post('/breakers/force-open', (req: Request, res: Response) => {
  const platform = String(req.body?.platform ?? 'openrouter');
  // 3 calls to bumpFail opens the breaker from any state. The breaker
  // module handles "from closed, 3 fails = open" and "from half-open, 1
  // fail = open" — we hit closed here so we go straight to open.
  breaker.bumpFail(platform as any);
  breaker.bumpFail(platform as any);
  const r = breaker.bumpFail(platform as any);
  res.json({ success: true, platform, opened: r.opened, snapshot: breaker.snapshot(platform as any) });
});

fallbackRouter.post('/breakers/force-close', (req: Request, res: Response) => {
  const platform = String(req.body?.platform ?? 'openrouter');
  // recordSuccess closes the breaker (handles half-open → closed correctly).
  breaker.recordSuccess(platform as any);
  res.json({ success: true, platform, snapshot: breaker.snapshot(platform as any) });
});

fallbackRouter.post('/cloud/sort/:preset', (req: Request, res: Response) => {
  const preset = String(req.params.preset);
  const db = getDb();

  if (preset === 'budget') {
    const allModels = db.prepare(`SELECT id, monthly_token_budget, tpd_limit FROM models`).all() as any[];
    allModels.sort((a, b) => getBudgetScore(b) - getBudgetScore(a));
    const upsert = db.prepare(`
      INSERT INTO cloud_fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)
      ON CONFLICT(model_db_id) DO UPDATE SET priority = excluded.priority, enabled = 1
    `);
    const reorder = db.transaction(() => {
      // Replace the chain entirely with all enabled models, ranked by budget.
      db.prepare(`DELETE FROM cloud_fallback_config`).run();
      const enabled = db.prepare(`SELECT id FROM models WHERE enabled = 1 AND id IN (${allModels.map(() => '?').join(',') || 'NULL'})`).all() as { id: number }[];
      // Only insert budget-preset rows for models that have a positive budget (or unlimited).
      // For now, insert the top-N where N is bounded by the local chain length cap; this
      // matches the local sort behavior.
      const top = allModels.slice(0, 50);
      top.forEach((m, i) => upsert.run(m.id, i + 1));
      return top.length;
    });
    const n = reorder();
    res.json({ success: true, preset, count: n });
    return;
  }

  const orderBy = CLOUD_SORT_PRESETS[preset];
  if (!orderBy) {
    res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget` } });
    return;
  }
  const models = db.prepare(`SELECT m.id FROM models m WHERE m.enabled = 1 ORDER BY ${orderBy}`).all() as { id: number }[];
  const upsert = db.prepare(`
    INSERT INTO cloud_fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)
    ON CONFLICT(model_db_id) DO UPDATE SET priority = excluded.priority, enabled = 1
  `);
  const reorder = db.transaction(() => {
    db.prepare(`DELETE FROM cloud_fallback_config`).run();
    models.forEach((m, i) => upsert.run(m.id, i + 1));
  });
  reorder();
  res.json({ success: true, preset });
});

fallbackRouter.post('/sort/:preset', (req: Request, res: Response) => {
  const preset = String(req.params.preset);
  const db = getDb();
  let models: { id: number }[] = [];

  if (preset === 'budget') {
    const allModels = db.prepare(`SELECT id, monthly_token_budget, tpd_limit FROM models`).all() as any[];
    allModels.sort((a, b) => getBudgetScore(b) - getBudgetScore(a));
    models = allModels.map(m => ({ id: m.id }));
  } else {
    const orderBy = SORT_PRESETS[preset];
    if (!orderBy) {
      res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget` } });
      return;
    }
    models = db.prepare(`SELECT m.id FROM models m ORDER BY ${orderBy}`).all() as { id: number }[];
  }

  const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
  const reorder = db.transaction(() => {
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });
  reorder();

  res.json({ success: true, preset });
});

// Token usage per model for the stacked bar
fallbackRouter.get('/token-usage', (_req: Request, res: Response) => {
  const db = getDb();

  // Get platforms that have enabled keys
  const platforms = db.prepare(`
    SELECT DISTINCT ak.platform
    FROM api_keys ak
    WHERE ak.enabled = 1
  `).all() as { platform: string }[];
  const platformSet = new Set(platforms.map(p => p.platform));

  // Check if there is an active profile
  const settingRow = db.prepare(`SELECT value FROM settings WHERE key = 'active_profile_id'`).get() as { value: string } | undefined;
  const activeProfileId = settingRow ? (parseInt(settingRow.value) || null) : null;

  // Verify active profile still exists
  const activeProfile = activeProfileId
    ? db.prepare('SELECT id FROM profiles WHERE id = ?').get(activeProfileId) as any
    : null;

  let rawModels: { model_db_id: number; platform: string; model_id: string; display_name: string; monthly_token_budget: string; priority: number; enabled: number; rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null }[];

  if (activeProfile) {
    // Profile mode: use profile_models chain (all models in profile, checked against enabled)
    rawModels = db.prepare(`
      SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name, m.monthly_token_budget,
             pm.priority, pm.enabled,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id
      WHERE pm.profile_id = ? AND m.enabled = 1
      ORDER BY pm.priority ASC
    `).all(activeProfileId) as any[];
  } else {
    // Default mode: use fallback_config (only include enabled models)
    rawModels = db.prepare(`
      SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name, m.monthly_token_budget,
             fc.priority, fc.enabled,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      WHERE m.enabled = 1
      ORDER BY fc.priority ASC
    `).all() as any[];
  }

  // Build per-model breakdown (only platforms with keys), preserving enabled state
  const modelBudgets = rawModels
    .filter(m => platformSet.has(m.platform))
    .map(m => ({
      modelDbId: m.model_db_id,
      displayName: m.display_name,
      platform: m.platform,
      budget: parseBudget(m.monthly_token_budget),
      enabled: m.enabled === 1,
      rpmLimit: m.rpm_limit,
      rpdLimit: m.rpd_limit,
      tpmLimit: m.tpm_limit,
      tpdLimit: m.tpd_limit,
    }));

  // Total budget counts all models (both enabled and disabled — they contribute to the pool)
  const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0);

  // Tokens used this month
  const usage = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_used
    FROM requests
    WHERE created_at >= datetime('now', 'start of month')
      AND request_type = 'chat'
  `).get() as { total_used: number };

  res.json({
    totalBudget,
    totalUsed: usage.total_used,
    models: modelBudgets,
  });
});
