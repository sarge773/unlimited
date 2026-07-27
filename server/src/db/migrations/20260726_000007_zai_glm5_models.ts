// Migration: seed z.ai GLM-5.x models (glm-5, glm-5.1, glm-5.2, glm-5-turbo)
// Created: 2026-07-26
//
// DOWN: reversible
//
// Surfaces the GLM-5.x flagship line on the `zai` provider (api.z.ai Coding
// Plan endpoint — registered in providers/index.ts). The legacy `zhipu`
// provider points at open.bigmodel.cn, which does not serve GLM-5.x, so these
// get their own platform rather than riding on zhipu.
//
// source='user' is load-bearing: catalog-sync's prune pass only deletes rows
// where source='catalog' (catalog-sync.ts ~L474-491), and inbound catalog
// collisions skip source='user' rows (~L354). The published catalog the
// install fetches does not list these GLM-5.x ids, so a source='catalog' seed
// would be deleted on every boot (this is why the existing
// nvidia/z-ai/glm-5.1 row vanishes for some installs). source='user' makes
// the seed persistent and non-clobbering without touching catalog-sync.
//
// Coding Plan is a subscription, not a free pool: no rpm/tpm caps and no
// monthly_token_budget (NULLs / empty). intelligence_rank is a within-tier
// tiebreak (lower = smarter); size_label='Frontier' dominates routing and
// matches the nvidia/z-ai/glm-5.1 anchor. Only glm-5.2's 1M context is
// documented; the others default to 128K.

import type { Db } from '../types.js';
import { ensureModelInProfiles } from '../../services/profile-models.js';

interface ModelRow {
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  contextWindow: number | null;
}

const PLATFORM = 'zai';

const ROWS: ModelRow[] = [
  { modelId: 'glm-5.2',      displayName: 'GLM-5.2 (Z.ai)',      intelligenceRank: 2, speedRank: 6, contextWindow: 1000000 },
  { modelId: 'glm-5.1',      displayName: 'GLM-5.1 (Z.ai)',      intelligenceRank: 4, speedRank: 6, contextWindow: 128000 },
  { modelId: 'glm-5',        displayName: 'GLM-5 (Z.ai)',        intelligenceRank: 6, speedRank: 6, contextWindow: 128000 },
  { modelId: 'glm-5-turbo',  displayName: 'GLM-5-Turbo (Z.ai)',  intelligenceRank: 8, speedRank: 3, contextWindow: 128000 },
];

export function up(db: Db): void {
  // Upsert (not INSERT OR IGNORE) so an explicit rollback→re-apply restores
  // enabled=1. In normal operation the migration runs exactly once per DB
  // (tracked in the migrations table), so the conflict branch only fires during
  // a manual round-trip — it never clobbers a user's later UI disable in
  // production. ON CONFLICT here (rather than delete-in-down) is what keeps the
  // round-trip test's surrogate-id snapshot stable: delete+reinsert would drift
  // the AUTOINCREMENT id/model_db_id and break id-stability, which every other
  // reversible migration preserves by being ALTER/backfill-only.
  const upsertModel = db.prepare(`
    INSERT INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
       enabled, source)
    VALUES (?, ?, ?, ?, ?, 'Frontier', NULL, NULL, NULL, NULL, '', ?, 1, 'user')
    ON CONFLICT(platform, model_id) DO UPDATE SET enabled = 1, source = 'user'
  `);
  const selectId = db.prepare(
    'SELECT id FROM models WHERE platform = ? AND model_id = ?',
  );
  const insertFb = db.prepare(
    'INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)',
  );
  const maxPriority = db.prepare(
    'SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config',
  );

  const apply = db.transaction(() => {
    let base = (maxPriority.get() as { mx: number }).mx;
    for (const r of ROWS) {
      upsertModel.run(
        PLATFORM,
        r.modelId,
        r.displayName,
        r.intelligenceRank,
        r.speedRank,
        r.contextWindow,
      );
      const row = selectId.get(PLATFORM, r.modelId) as { id: number } | undefined;
      if (row) {
        base += 1;
        insertFb.run(row.id, base);
        // Mirror what profile_chain_backfill / catalog-sync do for every other
        // model: add it to each profile's profile_models chain so it enters auto
        // routing. Idempotent (checks existence per profile), so re-runs and the
        // round-trip are stable.
        ensureModelInProfiles(db, row.id);
      }
    }
  });
  apply();
}

export function down(db: Db): void {
  // Soft-disable (not DELETE): keeps row ids stable for the round-trip snapshot
  // and leaves the rows inert rather than orphaning references. A subsequent up()
  // re-enables them. Hard-deleting would also work functionally but drifts
  // AUTOINCREMENT ids on re-insert.
  const placeholders = ROWS.map(() => '?').join(', ');
  db.prepare(
    `UPDATE models SET enabled = 0 WHERE platform = ? AND model_id IN (${placeholders})`,
  ).run(PLATFORM, ...ROWS.map((r) => r.modelId));
}
