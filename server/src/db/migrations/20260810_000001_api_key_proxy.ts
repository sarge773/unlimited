import type { Db } from '../types.js';

/**
 * Per-key proxy override (#590 follow-up): a key can carry its own
 * proxy_url (http/https/socks4/socks5/socks5h) so the same provider can be
 * reached from different exit IPs (avoiding geo-ban / risk control) while
 * the global proxy stays the default. Empty string = fall back to the
 * global proxy resolution (PROXY_URL → dashboard setting → env vars).
 */
export function up(db: Db): void {
  db.prepare(
    "ALTER TABLE api_keys ADD COLUMN proxy_url TEXT NOT NULL DEFAULT ''",
  ).run();
}

export function down(db: Db): void {
  // SQLite cannot drop a column in place (ALTER TABLE ... DROP COLUMN is
  // supported from 3.35 but the rebuild is not worth it for a default-empty
  // string column). Leaving the column in place is harmless — every read
  // treats '' as "no per-key override".
}
