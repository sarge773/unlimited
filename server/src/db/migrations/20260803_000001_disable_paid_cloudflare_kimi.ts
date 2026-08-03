// Migration: disable Cloudflare Kimi models that moved off the free tier
// Created: 2026-08-03
//
// Cloudflare Workers AI moved @cf/moonshotai/kimi-k2.6 and
// @cf/moonshotai/kimi-k2.7-code onto the Workers Paid plan, so every free-tier
// request now returns 403 and burns a fallback slot (issue #713). The monthly
// catalog snapshot still lists them enabled, so the bundled baseline disables
// them here — catalog-sync's rule is "local disable wins" (enabled = catalog
// enabled ? local : 0), so a stale catalog cannot re-enable these rows.
//
// DOWN: reversible — re-enables the two rows. The user can also flip them back
// on from the dashboard at any time.

import type { Db } from '../types.js';

const PAID_CLOUDFLARE_KIMI: ReadonlyArray<[string, string]> = [
  ['cloudflare', '@cf/moonshotai/kimi-k2.6'],
  ['cloudflare', '@cf/moonshotai/kimi-k2.7-code'],
];

export function up(db: Db): void {
  const disable = db.prepare(`UPDATE models SET enabled = 0 WHERE platform = ? AND model_id = ?`);
  for (const [platform, modelId] of PAID_CLOUDFLARE_KIMI) disable.run(platform, modelId);
}

export function down(db: Db): void {
  const enable = db.prepare(`UPDATE models SET enabled = 1 WHERE platform = ? AND model_id = ?`);
  for (const [platform, modelId] of PAID_CLOUDFLARE_KIMI) enable.run(platform, modelId);
}
