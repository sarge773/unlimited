import { getDb, getSetting, setSetting } from '../db/index.js';
import { getProfileContext } from '../lib/profile-context.js';

export function getProfileSetting(key: string): string | undefined {
  const profile = getProfileContext();
  if (!profile) return getSetting(key);
  const row = getDb().prepare(
    'SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?',
  ).get(profile.id, key) as { value: string } | undefined;
  return row?.value ?? getSetting(key);
}

export function setProfileSetting(key: string, value: string): void {
  const profile = getProfileContext();
  if (!profile) {
    setSetting(key, value);
    return;
  }
  getDb().prepare(`
    INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value
  `).run(profile.id, key, value);
}
