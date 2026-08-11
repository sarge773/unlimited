import type { Db } from '../types.js';

/**
 * #811: curated multimodal OpenCode models.
 *
 * OpenCode users need pinned coding + multimodal choices plus a capability-
 * first auto route. This seeds a small curated set of vision/video-capable
 * models on the opencode platform:
 *   - qwen-vl-plus-free: the Qwen VL vision analysis model used by the
 *     multimodal gateway for image requests aimed at non-visual targets;
 *   - gemini-2.5-flash-video / gemini-2.5-pro-video: explicitly selectable
 *     short-video analysis entries.
 *
 * All marked supports_vision=1; the existing auto route keeps every enabled
 * model eligible, so nothing else changes.
 *
 * The seeded rows use FIXED ids: the roundtrip test migrates up, down to
 * baseline, then up again and compares full snapshots — an AUTOINCREMENT id
 * would drift between the two ups and fail that comparison. 90xxxxx sits far
 * above the legacy baseline's id range, so no collision is possible.
 */
export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models
      (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, supports_vision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const additions: Array<[number, string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    [900001, 'opencode', 'qwen-vl-plus-free',      'Qwen VL Plus (OpenCode Zen, vision)',   8, 3, 'Large',    20, 200, null, null, 'promo (trial)', 131072],
    [900002, 'opencode', 'gemini-2.5-flash-video', 'Gemini 2.5 Flash (video analysis)',     5, 5, 'Large',    15, 100, null, null, 'promo (trial)', 1048576],
    [900003, 'opencode', 'gemini-2.5-pro-video',   'Gemini 2.5 Pro (video analysis)',       2, 2, 'Frontier', 10, 100, null, null, 'promo (trial)', 2097152],
  ];
  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
  });
  apply();
}

export function down(db: Db): void {
  db.prepare(`
    DELETE FROM models
    WHERE id BETWEEN 900001 AND 900003
  `).run();
}
