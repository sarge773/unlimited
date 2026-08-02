import type Database from 'better-sqlite3';
import type { Platform } from '@freellmapi/shared/types.js';
import { hasProvider } from '../providers/index.js';

function parseDisabledProviders(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export function getMissingEnabledProviders(db: Database.Database): string[] {
  const platforms = db.prepare(`
    SELECT DISTINCT platform
    FROM models
    WHERE enabled = 1
  `).all() as { platform: string }[];

  return platforms
    .map((row) => row.platform)
    .filter((platform) => !hasProvider(platform as Platform))
    .sort();
}

export function applyDisabledProviderMask(db: Database.Database, rawList = process.env.FREELLMAPI_DISABLED_PROVIDERS): string[] {
  const disabled = parseDisabledProviders(rawList);
  if (disabled.length === 0) return [];

  const updateModels = db.prepare(`UPDATE models SET enabled = 0 WHERE lower(platform) = ?`);
  const updateFallback = db.prepare(`UPDATE fallback_config SET enabled = 0 WHERE model_db_id IN (SELECT id FROM models WHERE lower(platform) = ?)`);
  const updateCloudFallback = db.prepare(`UPDATE cloud_fallback_config SET enabled = 0 WHERE model_db_id IN (SELECT id FROM models WHERE lower(platform) = ?)`);

  const apply = db.transaction(() => {
    for (const platform of disabled) {
      updateModels.run(platform);
      updateFallback.run(platform);
      updateCloudFallback.run(platform);
    }
  });
  apply();

  return disabled;
}

export function assertEnabledProvidersCovered(db: Database.Database): void {
  const missing = getMissingEnabledProviders(db);
  if (missing.length === 0) return;

  throw new Error(
    `Enabled catalog platforms have no registered provider(s): ${missing.join(', ')}. ` +
    `Restore the registrations in server/src/providers/index.ts or disable the matching catalog rows.`,
  );
}
