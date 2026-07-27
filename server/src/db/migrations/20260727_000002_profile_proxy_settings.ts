import type { Db } from '../types.js';

const PROXY_SETTING_DEFAULTS = {
  proxy_url: '',
  proxy_enabled: '1',
  proxy_bypass: '',
} as const;

export function up(db: Db): void {
  const profiles = db.prepare('SELECT id FROM profiles').all() as { id: number }[];
  const globalSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO profile_settings (profile_id, key, value)
    VALUES (?, ?, ?)
  `);
  for (const profile of profiles) {
    for (const [key, fallback] of Object.entries(PROXY_SETTING_DEFAULTS)) {
      const row = globalSetting.get(key) as { value: string } | undefined;
      insertSetting.run(profile.id, key, row?.value ?? fallback);
    }
  }
}

export function down(db: Db): void {
  const keys = Object.keys(PROXY_SETTING_DEFAULTS);
  const placeholders = keys.map(() => '?').join(', ');
  db.prepare(`DELETE FROM profile_settings WHERE key IN (${placeholders})`)
    .run(...keys);
}
