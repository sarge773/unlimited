import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/index.js';

export interface ProfileContext {
  id: number;
  name: string;
  slug: string;
  apiKey: string;
  isDefault: boolean;
}

const storage = new AsyncLocalStorage<ProfileContext>();

function rowToContext(row: any): ProfileContext {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    apiKey: row.api_key,
    isDefault: row.type === 'default',
  };
}

export function getProfileById(id: number): ProfileContext | null {
  const row = getDb().prepare(
    'SELECT id, name, slug, api_key, type FROM profiles WHERE id = ?',
  ).get(id);
  return row ? rowToContext(row) : null;
}

export function getProfileBySlug(slug: string): ProfileContext | null {
  const row = getDb().prepare(
    'SELECT id, name, slug, api_key, type FROM profiles WHERE slug = ? COLLATE NOCASE',
  ).get(slug);
  return row ? rowToContext(row) : null;
}

export function getDefaultProfile(): ProfileContext {
  const row = getDb().prepare(
    "SELECT id, name, slug, api_key, type FROM profiles WHERE type = 'default' ORDER BY id LIMIT 1",
  ).get();
  if (!row) throw new Error('Default profile is missing');
  return rowToContext(row);
}

export function getProfileContext(): ProfileContext | null {
  return storage.getStore() ?? null;
}

export function currentProfile(): ProfileContext {
  return getProfileContext() ?? getDefaultProfile();
}

function run(profile: ProfileContext, res: Response, next: NextFunction): void {
  storage.run(profile, next);
}

export function defaultProfileMiddleware(_req: Request, res: Response, next: NextFunction): void {
  run(getDefaultProfile(), res, next);
}

export function namedProfileMiddleware(req: Request, res: Response, next: NextFunction): void {
  const profile = getProfileBySlug(String(req.params.profileSlug ?? ''));
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found', type: 'not_found_error' } });
    return;
  }
  run(profile, res, next);
}

export function dashboardProfileMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = req.headers['x-profile-id'];
  if (raw == null) {
    next();
    return;
  }
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  const profile = Number.isInteger(id) ? getProfileById(id) : null;
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found', type: 'not_found_error' } });
    return;
  }
  run(profile, res, next);
}
