// Migration: analytics query performance indexes
// Created: 2026-08-24
//
// DOWN: reversible
//
// Analytics endpoints filter requests by created_at and join/filter on
// latency_ms, platform, status. Missing composite indexes force full table
// scans, causing first page load stalls on large datasets.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_requests_created_latency ON requests(created_at, latency_ms)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_requests_created_platform_latency ON requests(created_at, platform, latency_ms)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_requests_created_status ON requests(created_at, status)',
  ).run();
}

export function down(db: Db): void {
  db.prepare('DROP INDEX IF EXISTS idx_requests_created_latency').run();
  db.prepare('DROP INDEX IF EXISTS idx_requests_created_platform_latency').run();
  db.prepare('DROP INDEX IF EXISTS idx_requests_created_status').run();
}
