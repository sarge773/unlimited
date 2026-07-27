import crypto from 'crypto';
import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .some(row => row.name === column);
}

function hasTable(db: Db, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

const RESERVED_PROFILE_SLUGS = new Set([
  'api', 'v1', 'mcp', 'models', 'keys', 'analytics', 'playground',
  'premium', 'assets', 'auth', 'health',
]);

function slugify(name: string, id: number): string {
  const base = name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!base) return `profile-${id}`;
  return RESERVED_PROFILE_SLUGS.has(base) ? `profile-${base}` : base;
}

function uniqueSlug(root: string, used: Set<string>): string {
  let slug = root.slice(0, 40);
  let suffixNumber = 2;
  while (used.has(slug)) {
    const suffix = `-${suffixNumber++}`;
    slug = `${root.slice(0, 40 - suffix.length)}${suffix}`;
  }
  return slug;
}

const PROFILE_SETTING_KEYS = [
  'routing_strategy',
  'routing_custom_weights',
  'fusion_config',
  'anthropic_model_map',
  'embeddings_default_family',
  'unify_models_enabled',
  'model_unify_overrides',
  'response_cache_enabled',
  'request_max_tokens_budget',
  'max_consecutive_upstream_fails',
  'fallback_time_budget_ms',
];

export function up(db: Db): void {
  if (!hasColumn(db, 'profiles', 'slug')) {
    db.prepare('ALTER TABLE profiles ADD COLUMN slug TEXT').run();
  }
  if (!hasColumn(db, 'profiles', 'api_key')) {
    db.prepare('ALTER TABLE profiles ADD COLUMN api_key TEXT').run();
  }

  const profiles = db.prepare('SELECT id, name, type, slug, api_key FROM profiles ORDER BY id')
    .all() as Array<{ id: number; name: string; type: string; slug: string | null; api_key: string | null }>;
  const legacy = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'")
    .get() as { value: string } | undefined;
  const used = new Set<string>();
  for (const profile of profiles) {
    const root = profile.type === 'default' ? 'default' : slugify(profile.name, profile.id);
    const slug = uniqueSlug(root, used);
    used.add(slug);
    const apiKey = profile.api_key
      ?? (profile.type === 'default' && legacy?.value
        ? legacy.value
        : `freellmapi-${crypto.randomBytes(24).toString('hex')}`);
    db.prepare('UPDATE profiles SET slug = ?, api_key = ? WHERE id = ?').run(slug, apiKey, profile.id);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_slug_nocase
      ON profiles(slug COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_api_key
      ON profiles(api_key);

    CREATE TABLE IF NOT EXISTS profile_settings (
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (profile_id, key)
    );

    CREATE TABLE IF NOT EXISTS profile_embedding_models (
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      embedding_model_id INTEGER NOT NULL REFERENCES embedding_models(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (profile_id, embedding_model_id)
    );

    CREATE TABLE IF NOT EXISTS profile_media_models (
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      media_model_id INTEGER NOT NULL REFERENCES media_models(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (profile_id, media_model_id)
    );
  `);

  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO profile_settings (profile_id, key, value)
    SELECT ?, key, value FROM settings WHERE key = ?
  `);
  const seedEmbedding = db.prepare(`
    INSERT OR IGNORE INTO profile_embedding_models
      (profile_id, embedding_model_id, priority, enabled)
    SELECT ?, id, priority, enabled FROM embedding_models
  `);
  const seedMedia = db.prepare(`
    INSERT OR IGNORE INTO profile_media_models
      (profile_id, media_model_id, priority, enabled)
    SELECT ?, id, priority, enabled FROM media_models
  `);
  for (const profile of profiles) {
    for (const key of PROFILE_SETTING_KEYS) insertSetting.run(profile.id, key);
    seedEmbedding.run(profile.id);
    seedMedia.run(profile.id);
  }

  if (!hasColumn(db, 'requests', 'profile_id')) {
    db.prepare('ALTER TABLE requests ADD COLUMN profile_id INTEGER').run();
  }
  if (!hasColumn(db, 'requests', 'profile_slug')) {
    db.prepare('ALTER TABLE requests ADD COLUMN profile_slug TEXT').run();
  }
  const defaultProfile = db.prepare("SELECT id, slug FROM profiles WHERE type = 'default' LIMIT 1")
    .get() as { id: number; slug: string } | undefined;
  if (defaultProfile) {
    db.prepare('UPDATE requests SET profile_id = ?, profile_slug = ? WHERE profile_id IS NULL')
      .run(defaultProfile.id, defaultProfile.slug);
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_requests_profile_created ON requests(profile_id, created_at)').run();

  // Keep the legacy installation-wide aggregate for backwards compatibility
  // and maintain a parallel profile-keyed aggregate for isolated dashboards.
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_request_hourly (
      hour TEXT NOT NULL,
      profile_id INTEGER NOT NULL,
      total_requests INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour, profile_id)
    );
    CREATE INDEX IF NOT EXISTS idx_profile_request_hourly_profile_hour
      ON profile_request_hourly(profile_id, hour);
  `);
  if (defaultProfile && hasTable(db, 'request_hourly')) {
    db.prepare(`
      INSERT OR IGNORE INTO profile_request_hourly
        (hour, profile_id, total_requests, success_count, error_count, input_tokens, output_tokens)
      SELECT hour, ?, total_requests, success_count, error_count, input_tokens, output_tokens
      FROM request_hourly
    `).run(defaultProfile.id);
    db.prepare(`
      CREATE TRIGGER IF NOT EXISTS trg_request_hourly_profile_insert
      AFTER INSERT ON request_hourly
      BEGIN
        INSERT INTO profile_request_hourly
          (hour, profile_id, total_requests, success_count, error_count, input_tokens, output_tokens)
        VALUES (NEW.hour, ${defaultProfile.id}, NEW.total_requests, NEW.success_count,
                NEW.error_count, NEW.input_tokens, NEW.output_tokens)
        ON CONFLICT(hour, profile_id) DO UPDATE SET
          total_requests = total_requests + NEW.total_requests,
          success_count = success_count + NEW.success_count,
          error_count = error_count + NEW.error_count,
          input_tokens = input_tokens + NEW.input_tokens,
          output_tokens = output_tokens + NEW.output_tokens;
      END
    `).run();
    db.prepare(`
      CREATE TRIGGER IF NOT EXISTS trg_request_hourly_profile_update
      AFTER UPDATE ON request_hourly
      BEGIN
        INSERT INTO profile_request_hourly
          (hour, profile_id, total_requests, success_count, error_count, input_tokens, output_tokens)
        VALUES (NEW.hour, ${defaultProfile.id},
                NEW.total_requests - OLD.total_requests,
                NEW.success_count - OLD.success_count,
                NEW.error_count - OLD.error_count,
                NEW.input_tokens - OLD.input_tokens,
                NEW.output_tokens - OLD.output_tokens)
        ON CONFLICT(hour, profile_id) DO UPDATE SET
          total_requests = total_requests + NEW.total_requests - OLD.total_requests,
          success_count = success_count + NEW.success_count - OLD.success_count,
          error_count = error_count + NEW.error_count - OLD.error_count,
          input_tokens = input_tokens + NEW.input_tokens - OLD.input_tokens,
          output_tokens = output_tokens + NEW.output_tokens - OLD.output_tokens;
      END
    `).run();
  }
}

export function down(db: Db): void {
  db.prepare('DROP TRIGGER IF EXISTS trg_request_hourly_profile_update').run();
  db.prepare('DROP TRIGGER IF EXISTS trg_request_hourly_profile_insert').run();
  db.prepare('DROP INDEX IF EXISTS idx_profile_request_hourly_profile_hour').run();
  db.prepare('DROP TABLE IF EXISTS profile_request_hourly').run();
  db.prepare('DROP INDEX IF EXISTS idx_requests_profile_created').run();
  if (hasColumn(db, 'requests', 'profile_slug')) db.prepare('ALTER TABLE requests DROP COLUMN profile_slug').run();
  if (hasColumn(db, 'requests', 'profile_id')) db.prepare('ALTER TABLE requests DROP COLUMN profile_id').run();
  db.prepare('DROP TABLE IF EXISTS profile_media_models').run();
  db.prepare('DROP TABLE IF EXISTS profile_embedding_models').run();
  db.prepare('DROP TABLE IF EXISTS profile_settings').run();
  db.prepare('DROP INDEX IF EXISTS idx_profiles_api_key').run();
  db.prepare('DROP INDEX IF EXISTS idx_profiles_slug_nocase').run();
  if (hasColumn(db, 'profiles', 'api_key')) db.prepare('ALTER TABLE profiles DROP COLUMN api_key').run();
  if (hasColumn(db, 'profiles', 'slug')) db.prepare('ALTER TABLE profiles DROP COLUMN slug').run();
}
