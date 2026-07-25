import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import type { Db } from '../db/types.js';
import type { Scheduler } from './scheduler.js';
import { getDefaultDbPath } from '../db/index.js';
import { restrictToOwner } from './file-permissions.js';

const MAGIC = Buffer.from('FAPIBK1\0');
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const PLACEHOLDER_KEY = 'replace-with-64-char-hex';

export interface DbBackupResult {
  ok: boolean;
  target?: string;
  bytes?: number;
  restored?: boolean;
  skipped?: string;
}

function backupTarget(): string | null {
  const raw = process.env.FREEAPI_DB_BACKUP_TARGET
    ?? process.env.FREEAPI_DB_BACKUP_URL
    ?? process.env.FREEAPI_DB_BACKUP_PATH
    ?? '';
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isDbBackupConfigured(): boolean {
  return backupTarget() !== null;
}

function backupIntervalMs(): number {
  const raw = process.env.FREEAPI_DB_BACKUP_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_INTERVAL_MS;
}

function isHttpTarget(target: string): boolean {
  return target.startsWith('https://') || target.startsWith('http://');
}

function parseBackupKey(): Buffer {
  const raw = (process.env.FREEAPI_DB_BACKUP_KEY || process.env.ENCRYPTION_KEY || '').trim();
  if (!raw || raw === PLACEHOLDER_KEY || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('FREEAPI_DB_BACKUP_KEY or ENCRYPTION_KEY must be a 64-character hex key when DB backup is enabled');
  }
  return Buffer.from(raw, 'hex');
}

function encryptBackup(plain: Buffer): Buffer {
  const key = parseBackupKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

function decryptBackup(payload: Buffer): Buffer {
  if (payload.length < MAGIC.length + 12 + 16 || !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('backup payload has an unsupported format');
  }
  const key = parseBackupKey();
  const ivStart = MAGIC.length;
  const tagStart = ivStart + 12;
  const bodyStart = tagStart + 16;
  const iv = payload.subarray(ivStart, tagStart);
  const tag = payload.subarray(tagStart, bodyStart);
  const ciphertext = payload.subarray(bodyStart);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Hugging Face Dataset/Model repos serve downloads via /resolve/{rev}/{path}
// (302 → CDN), but uploads must go through the commit API at
// /api/{type}/{ns}/{repo}/commit/{rev} with a JSON-lines payload of base64
// file content. A plain PUT to the /resolve URL fails silently (HF returns 404
// or 405), so the backup never lands and the next cold start has nothing to
// restore — surfacing as the "create your account" loop on ephemeral hosts.
// Detect HF /resolve URLs and route the upload through the commit API.
export function parseHuggingFaceTarget(target: string): { commitUrl: string; filePath: string } | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.hostname !== 'huggingface.co') return null;

  // /datasets/{ns}/{repo}/resolve/{rev}/{path...}  →  /api/datasets/{ns}/{repo}/commit/{rev}
  // /{ns}/{repo}/resolve/{rev}/{path...}           →  /api/models/{ns}/{repo}/commit/{rev}  (legacy model path)
  const parts = url.pathname.split('/').filter(Boolean);
  let type: 'datasets' | 'models' | null = null;
  let rest: string[] = [];
  if (parts[0] === 'datasets' && parts.length >= 5 && parts[3] === 'resolve') {
    type = 'datasets';
    rest = parts.slice(1);
  } else if (parts.length >= 4 && parts[2] === 'resolve') {
    type = 'models';
    rest = parts;
  } else {
    return null;
  }
  const ns = rest[0];
  const repo = rest[1];
  const rev = rest[3];
  const filePath = rest.slice(4).join('/');
  if (!ns || !repo || !rev || !filePath) return null;
  const commitUrl = `https://huggingface.co/api/${type}/${ns}/${repo}/commit/${rev}`;
  return { commitUrl, filePath };
}

async function uploadToHuggingFace(
  commitUrl: string,
  filePath: string,
  payload: Buffer,
  token: string,
): Promise<void> {
  const body = [
    { key: 'header', value: { summary: `chore: update ${filePath}` } },
    { key: 'file', value: { path: filePath, content: payload.toString('base64'), encoding: 'base64' } },
  ];
  const res = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-ndjson',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body.map((line) => JSON.stringify(line)).join('\n'),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`backup upload failed: HF commit HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
}

async function readTarget(target: string): Promise<Buffer | null> {
  if (isHttpTarget(target)) {
    const headers: Record<string, string> = {};
    const token = process.env.FREEAPI_DB_BACKUP_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(target, { method: 'GET', headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) throw new Error(`backup restore failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target);
}

async function writeTarget(target: string, payload: Buffer): Promise<void> {
  if (isHttpTarget(target)) {
    const token = process.env.FREEAPI_DB_BACKUP_TOKEN?.trim();
    const hf = parseHuggingFaceTarget(target);
    if (hf) {
      if (!token) throw new Error('FREEAPI_DB_BACKUP_TOKEN is required for Hugging Face backup uploads');
      await uploadToHuggingFace(hf.commitUrl, hf.filePath, payload, token);
      return;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(target, {
      method: 'PUT',
      headers,
      body: payload,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`backup upload failed: HTTP ${res.status}`);
    return;
  }

  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  // Encrypted, but not therefore safe to leave world-readable: the key is
  // FREEAPI_DB_BACKUP_KEY or ENCRYPTION_KEY, which on a normal install sits in a
  // .env file on the same host. The mode covers creation; restrictToOwner covers
  // the overwrite case, where an existing file keeps the mode it already had —
  // and covers Windows, where the mode argument is a no-op.
  fs.writeFileSync(target, payload, { mode: 0o600 });
  if (!restrictToOwner(target)) {
    console.warn(`[db-backup] could not restrict permissions on ${target} — it may be readable by other local accounts`);
  }
}

export async function restoreDbBackupIfNeeded(dbPath = getDefaultDbPath()): Promise<DbBackupResult> {
  const target = backupTarget();
  if (!target) return { ok: true, skipped: 'not configured' };
  if (dbPath === ':memory:') return { ok: true, target, skipped: 'memory database' };
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) return { ok: true, target, skipped: 'database already exists' };

  const payload = await readTarget(target);
  if (!payload || payload.length === 0) return { ok: true, target, skipped: 'no backup found' };

  let restored: Buffer;
  try {
    restored = gunzipSync(decryptBackup(payload));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`could not restore SQLite backup from ${target}: ${detail}`);
  }

  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  // This is the decrypted database — provider keys and the dashboard password
  // hash in the clear. connectDb hardens it too, but that is a later call and
  // sometimes a later process; the file must not be readable in between.
  fs.writeFileSync(dbPath, restored, { mode: 0o600 });
  if (!restrictToOwner(dbPath)) {
    console.warn(`[db-backup] could not restrict permissions on the restored database at ${dbPath}`);
  }
  console.log(`[db-backup] restored ${restored.length} bytes from ${target}`);
  return { ok: true, target, bytes: restored.length, restored: true };
}

export async function backupDbNow(db: Db, dbPath = getDefaultDbPath()): Promise<DbBackupResult> {
  const target = backupTarget();
  if (!target) return { ok: true, skipped: 'not configured' };
  if (dbPath === ':memory:') return { ok: true, target, skipped: 'memory database' };
  if (!fs.existsSync(dbPath)) return { ok: false, target, skipped: 'database file missing' };

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Best effort: reading the main DB still works for rollback-journal or quiet WAL DBs.
  }

  const plain = fs.readFileSync(dbPath);
  const payload = encryptBackup(gzipSync(plain));
  await writeTarget(target, payload);
  console.log(`[db-backup] uploaded ${plain.length} bytes to ${target}`);
  return { ok: true, target, bytes: plain.length };
}

export function startDbBackupPump(db: Db, scheduler: Scheduler, dbPath = getDefaultDbPath()): (() => void) | null {
  if (!backupTarget()) return null;
  const run = () => {
    void backupDbNow(db, dbPath).catch(err => {
      console.warn(`[db-backup] ${err instanceof Error ? err.message : err}`);
    });
  };
  run();
  return scheduler.every(backupIntervalMs(), run);
}
