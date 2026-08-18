import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDbNow, restoreDbBackupIfNeeded, parseHuggingFaceTarget } from '../../lib/db-backup.js';
import { aclEntries } from '../helpers/acl.js';

const ORIGINAL_BACKUP_PATH = process.env.FREEAPI_DB_BACKUP_PATH;
const ORIGINAL_BACKUP_TARGET = process.env.FREEAPI_DB_BACKUP_TARGET;
const ORIGINAL_BACKUP_URL = process.env.FREEAPI_DB_BACKUP_URL;
const ORIGINAL_BACKUP_KEY = process.env.FREEAPI_DB_BACKUP_KEY;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

function restoreEnv() {
  if (ORIGINAL_BACKUP_PATH === undefined) delete process.env.FREEAPI_DB_BACKUP_PATH;
  else process.env.FREEAPI_DB_BACKUP_PATH = ORIGINAL_BACKUP_PATH;
  if (ORIGINAL_BACKUP_TARGET === undefined) delete process.env.FREEAPI_DB_BACKUP_TARGET;
  else process.env.FREEAPI_DB_BACKUP_TARGET = ORIGINAL_BACKUP_TARGET;
  if (ORIGINAL_BACKUP_URL === undefined) delete process.env.FREEAPI_DB_BACKUP_URL;
  else process.env.FREEAPI_DB_BACKUP_URL = ORIGINAL_BACKUP_URL;
  if (ORIGINAL_BACKUP_KEY === undefined) delete process.env.FREEAPI_DB_BACKUP_KEY;
  else process.env.FREEAPI_DB_BACKUP_KEY = ORIGINAL_BACKUP_KEY;
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
}

describe('encrypted SQLite backup', () => {
  afterEach(() => restoreEnv());

  it('backs up and restores a SQLite file from a configured path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-db-backup-'));
    const dbPath = path.join(dir, 'freeapi.db');
    const backupPath = path.join(dir, 'backup.bin');
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    process.env.FREEAPI_DB_BACKUP_PATH = backupPath;

    const db = new Database(dbPath);
    db.exec('CREATE TABLE items (name TEXT NOT NULL); INSERT INTO items (name) VALUES (\'survived\')');
    const backup = await backupDbNow(db, dbPath);
    db.close();

    expect(backup.ok).toBe(true);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath).includes(Buffer.from('survived'))).toBe(false);

    fs.rmSync(dbPath);
    const restore = await restoreDbBackupIfNeeded(dbPath);
    expect(restore.restored).toBe(true);

    const restored = new Database(dbPath);
    expect((restored.prepare('SELECT name FROM items').get() as { name: string }).name).toBe('survived');
    restored.close();
  });
});

describe('backup file permissions', () => {
  // The blob is AES-256-GCM encrypted and the restored file is a plain SQLite
  // database, but both live on a host that also holds the key — usually in a
  // .env in the same tree — so neither may be left world-readable.
  //
  // As elsewhere, each platform asserts what it can actually enforce: Node
  // synthesizes a 0o666 mode on Windows regardless of the ACL, so a POSIX-mode
  // assertion there would pass or fail for reasons unrelated to the guarantee.
  const isWindows = process.platform === 'win32';
  const itPosix = it.skipIf(isWindows);
  const itWindows = it.skipIf(!isWindows);

  afterEach(() => restoreEnv());

  async function backupInto(dir: string): Promise<string> {
    const dbPath = path.join(dir, 'freeapi.db');
    const backupPath = path.join(dir, 'backup.bin');
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    process.env.FREEAPI_DB_BACKUP_PATH = backupPath;

    const db = new Database(dbPath);
    db.exec('CREATE TABLE items (name TEXT NOT NULL)');
    await backupDbNow(db, dbPath);
    db.close();
    return backupPath;
  }

  itPosix('writes the backup blob owner-only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-backup-perms-'));
    const backupPath = await backupInto(dir);

    expect(fs.statSync(backupPath).mode & 0o077).toBe(0);
  });

  itPosix('tightens a backup target that already existed', async () => {
    // writeFileSync's mode argument only applies when the file is created, so
    // every backup after the first overwrites a file that keeps whatever mode
    // it already had. Without the explicit restrict call this is the case that
    // stays group-readable forever.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-backup-perms-'));
    const backupPath = path.join(dir, 'backup.bin');
    fs.writeFileSync(backupPath, 'stale');
    // chmod rather than a creation mode: the mode argument is filtered through
    // the runner's umask, so a strict umask would leave this pre-condition
    // asserting the very thing it means to rule out.
    fs.chmodSync(backupPath, 0o644);
    expect(fs.statSync(backupPath).mode & 0o077).not.toBe(0);

    await backupInto(dir);

    expect(fs.statSync(backupPath).mode & 0o077).toBe(0);
  });

  itPosix('writes the restored database owner-only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-backup-perms-'));
    const dbPath = path.join(dir, 'freeapi.db');
    await backupInto(dir);
    fs.rmSync(dbPath);

    // The restore lands before connectDb runs, and sometimes in a different
    // process entirely; the decrypted database must not be readable in between.
    expect((await restoreDbBackupIfNeeded(dbPath)).restored).toBe(true);
    expect(fs.statSync(dbPath).mode & 0o077).toBe(0);
  });

  itWindows('replaces the inherited ACL on the backup blob', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-backup-perms-'));
    const backupPath = await backupInto(dir);

    const entries = aclEntries(backupPath);
    expect(entries.filter(e => e.includes('(I)'))).toEqual([]);
    expect(entries).toHaveLength(3);
  });
});

describe('parseHuggingFaceTarget', () => {
  it('parses a dataset /resolve URL into a commit API URL + file path', () => {
    const out = parseHuggingFaceTarget(
      'https://huggingface.co/datasets/tayyabimam/freeLLMAPI/resolve/main/freeapi.db.backup',
    );
    expect(out).toEqual({
      commitUrl: 'https://huggingface.co/api/datasets/tayyabimam/freeLLMAPI/commit/main',
      filePath: 'freeapi.db.backup',
    });
  });

  it('parses a legacy model /resolve URL (no /models prefix) into a models commit URL', () => {
    const out = parseHuggingFaceTarget(
      'https://huggingface.co/bert/base/resolve/main/config.json',
    );
    expect(out).toEqual({
      commitUrl: 'https://huggingface.co/api/models/bert/base/commit/main',
      filePath: 'config.json',
    });
  });

  it('parses a nested file path under a dataset', () => {
    const out = parseHuggingFaceTarget(
      'https://huggingface.co/datasets/acme/data/resolve/main/backups/db.bin',
    );
    expect(out).toEqual({
      commitUrl: 'https://huggingface.co/api/datasets/acme/data/commit/main',
      filePath: 'backups/db.bin',
    });
  });

  it('parses a non-main revision', () => {
    const out = parseHuggingFaceTarget(
      'https://huggingface.co/datasets/acme/data/resolve/v1.2/freeapi.db.backup',
    );
    expect(out).toEqual({
      commitUrl: 'https://huggingface.co/api/datasets/acme/data/commit/v1.2',
      filePath: 'freeapi.db.backup',
    });
  });

  it('returns null for a non-HF URL', () => {
    expect(parseHuggingFaceTarget('https://example.com/datasets/x/y/resolve/main/z')).toBeNull();
  });

  it('returns null for an HF URL that is not a /resolve path', () => {
    expect(parseHuggingFaceTarget('https://huggingface.co/api/datasets/x/y')).toBeNull();
    expect(parseHuggingFaceTarget('https://huggingface.co/datasets/x/y/tree/main')).toBeNull();
  });

  it('returns null for an invalid URL', () => {
    expect(parseHuggingFaceTarget('not a url')).toBeNull();
  });
});

describe('Hugging Face upload/restore round trip', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    restoreEnv();
  });

  it('uploads the backup as base64 text (not a binary blob) and restores it back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-db-backup-hf-'));
    const dbPath = path.join(dir, 'freeapi.db');
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    process.env.FREEAPI_DB_BACKUP_URL = 'https://huggingface.co/datasets/acme/data/resolve/main/freeapi.db.backup';
    process.env.FREEAPI_DB_BACKUP_TOKEN = 'hf_test_token';

    const db = new Database(dbPath);
    db.exec('CREATE TABLE items (name TEXT NOT NULL); INSERT INTO items (name) VALUES (\'survived\')');

    let uploadedText: string | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        // Commit-API upload: the ndjson `file` line must carry no `encoding`
        // field — that is what keeps the git blob a plain-text base64 string
        // instead of a binary blob Xet-backed repos reject.
        const lines = String(init.body).split('\n').map((l) => JSON.parse(l));
        const fileLine = lines.find((l) => l.key === 'file');
        expect(fileLine.value.encoding).toBeUndefined();
        uploadedText = fileLine.value.content as string;
        return new Response(null, { status: 200 });
      }
      // GET /resolve/ download: HF serves back exactly what was committed.
      return new Response(uploadedText, { status: 200 });
    }) as typeof fetch;

    const backup = await backupDbNow(db, dbPath);
    db.close();
    expect(backup.ok).toBe(true);
    expect(uploadedText).toBeDefined();
    // The uploaded content must itself be valid base64 (proof it is text, not raw binary).
    expect(() => Buffer.from(uploadedText!, 'base64')).not.toThrow();

    fs.rmSync(dbPath);
    const restore = await restoreDbBackupIfNeeded(dbPath);
    expect(restore.restored).toBe(true);

    const restored = new Database(dbPath);
    expect((restored.prepare('SELECT name FROM items').get() as { name: string }).name).toBe('survived');
    restored.close();
  });
});
