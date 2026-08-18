import type { Db } from '../types.js';

/**
 * Curated OpenCode multimodal models (#814, part of #811 / the #843
 * multimodal slice).
 *
 * Expose the selected coding/visual/short-video models as individual OpenCode
 * choices while the complete enabled catalog stays behind capability-first
 * auto routing. The three curated entries:
 *   - Qwen VL            — vision (image understanding, UI screenshots)
 *   - Gemini 3.5 Flash   — short-video analysis
 *   - Gemini 3 Flash Preview — short-video analysis
 *
 * Fixed model ids make the migration roundtrip-stable (up → down → up yields
 * identical rows). Models carry supports_vision = 1 so capability-first auto
 * routing can use them for image/video requests, and are also available as
 * pinned OpenCode choices.
 *
 * DOWN is a soft disable (enabled = 0) rather than a delete: SQLite's
 * AUTOINCREMENT never reuses ids, so deleting and re-inserting rows on an
 * up → down → up round trip would drift every model_db_id in fallback_config
 * and break the roundtrip test's full-state equality. Soft-disable keeps the
 * ids stable, and up() re-enables idempotently.
 */

// Column order of the models INSERT below. models gains columns over time
// (supports_vision, endpoint_scope, ...), so the statement is written against
// the CURRENT schema — same pattern as the V18 OpenCode Zen seed.
const COLUMNS = `
  (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
   rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
   supports_vision)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

type ModelRow = [
  platform: string,
  modelId: string,
  displayName: string,
  intelRank: number,
  speedRank: number,
  sizeLabel: string,
  rpm: number | null,
  rpd: number | null,
  tpm: number | null,
  tpd: number | null,
  budget: string,
  contextWindow: number | null,
  supportsVision: number,
];

// Promotional free-tier limits mirror the existing OpenCode Zen rows (V18):
// conservative shared 20 RPM / 200 RPD. Vision rows get the same limits; the
// 128K context matches the other Zen catalog rows.
const ADDITIONS: ModelRow[] = [
  ['opencode', 'qwen-vl',                 'Qwen VL (OpenCode Zen)',                6, 4, 'Large',    20, 200, null, null, 'promo (trial)', 131072, 1],
  ['opencode', 'gemini-3.5-flash',        'Gemini 3.5 Flash (OpenCode Zen)',       8, 4, 'Large',    20, 200, null, null, 'promo (trial)', 131072, 1],
  ['opencode', 'gemini-3-flash-preview',  'Gemini 3 Flash Preview (OpenCode Zen)', 9, 4, 'Large',    20, 200, null, null, 'promo (trial)', 131072, 1],
];

const MODEL_IDS = ADDITIONS.map(r => r[1]);
const PLACEHOLDERS = MODEL_IDS.map(() => '?').join(', ');

// Backfill fallback_config ONLY for the curated rows, never the whole models
// table: a full-table backfill is order-dependent and would add different
// rows on a second up() after other migrations' down() steps, breaking the
// roundtrip test's full-state equality.
function backfillCuratedFallback(db: Db): void {
  const missing = db.prepare(`
    SELECT m.id FROM models m
    LEFT JOIN fallback_config f ON m.id = f.model_db_id
    WHERE m.platform = 'opencode' AND m.model_id IN (${PLACEHOLDERS}) AND f.id IS NULL
    ORDER BY m.intelligence_rank ASC
  `).all(...MODEL_IDS) as { id: number }[];
  if (missing.length === 0) return;
  const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
  const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
  for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
}

// Mirror profile_chain_backfill (20260714) for the curated rows only. That
// migration runs BEFORE this one, so on a first up() our models don't exist
// yet and it can't add them to profile_models; on an up→down→up round trip
// they DO exist (down() only soft-disables), so the backfill would add them
// the second time but not the first — breaking the roundtrip test's
// full-state equality. Backfilling here keeps both passes identical.
function backfillCuratedProfiles(db: Db): void {
  const profiles = db.prepare('SELECT id FROM profiles ORDER BY id ASC').all() as { id: number }[];
  if (profiles.length === 0) return;

  const missing = db.prepare(`
    SELECT f.priority, m.id AS model_db_id
      FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
     WHERE m.platform = 'opencode' AND m.model_id IN (${PLACEHOLDERS}) AND pm.id IS NULL
     ORDER BY f.priority, m.id
  `);
  const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM profile_models WHERE profile_id = ?');
  const insertPm = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)');

  for (const profile of profiles) {
    const rows = missing.all(profile.id, ...MODEL_IDS) as { priority: number; model_db_id: number }[];
    if (rows.length === 0) continue;
    const max = maxPriority.get(profile.id) as { mx: number };
    rows.forEach((row, index) => {
      insertPm.run(profile.id, row.model_db_id, max.mx + index + 1);
    });
  }
}

export function up(db: Db): void {
  const existing = db.prepare(
    `SELECT id FROM models WHERE platform = 'opencode' AND model_id = ?`,
  );
  const insert = db.prepare(`INSERT OR IGNORE INTO models ${COLUMNS}`);
  const reenable = db.prepare(
    `UPDATE models SET enabled = 1, supports_vision = 1 WHERE platform = 'opencode' AND model_id = ?`,
  );
  const apply = db.transaction(() => {
    for (const row of ADDITIONS) {
      // Idempotent re-enable after a soft-disable down(): the row keeps its
      // id, so fallback_config references stay stable across the round trip.
      if (existing.get(row[1])) {
        reenable.run(row[1]);
      } else {
        insert.run(...row);
      }
    }
    backfillCuratedFallback(db);
    backfillCuratedProfiles(db);
  });
  apply();
}

export function down(db: Db): void {
  // Soft disable — never delete: ids must survive for the roundtrip test's
  // full-state equality (see header comment).
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'opencode' AND model_id IN (${PLACEHOLDERS})`).run(...MODEL_IDS);
}
