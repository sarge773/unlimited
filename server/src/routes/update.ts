import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { Router } from 'express';
import type { Request, Response } from 'express';

const REPOSITORY = 'tashfeenahmed/freellmapi';
const CACHE_TTL_MS = 5 * 60 * 1000;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const COMPARE_STATUSES = ['identical', 'ahead', 'behind', 'diverged'] as const;
const MAX_CHANGES = 8;
const MAX_CHANGE_MESSAGE_LENGTH = 160;
const MAX_ATOM_FEED_LENGTH = 1_000_000;

type Installation = 'source' | 'docker' | 'desktop' | 'unknown';
type CheckStatus = 'current' | 'available' | 'ahead' | 'diverged' | 'unknown' | 'unsupported';
type CompareStatus = (typeof COMPARE_STATUSES)[number];

interface Identity {
  sha: string | null;
  installation: Installation;
}

interface CheckResult {
  status: CheckStatus;
  installation: Installation;
  localSha: string | null;
  checkedAt: string;
  remoteSha?: string;
  remoteMessage?: string;
  remoteDate?: string;
  changes?: Change[];
}

interface Change {
  sha: string;
  message: string;
  date?: string;
}

interface CachedResult {
  result: CheckResult;
  cachedAt: number;
}

type ExecFileSync = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: 'utf8'; timeout: number },
) => string | Buffer;

export interface UpdateRouterOptions {
  fetch?: typeof globalThis.fetch;
  execFileSync?: ExecFileSync;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  logger?: Pick<Console, 'error'>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSha(value: unknown): string | null {
  return typeof value === 'string' && SHA_PATTERN.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function compareStatus(value: unknown): CompareStatus | null {
  return typeof value === 'string' && (COMPARE_STATUSES as readonly string[]).includes(value)
    ? value as CompareStatus
    : null;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function mapCompareStatus(status: CompareStatus): Exclude<CheckStatus, 'unknown' | 'unsupported'> {
  switch (status) {
    case 'identical': return 'current';
    case 'ahead': return 'available';
    case 'behind': return 'ahead';
    case 'diverged': return 'diverged';
  }
}

function remoteCommit(body: Record<string, unknown>, status: CompareStatus): Record<string, unknown> | null {
  if (!Array.isArray(body.commits)) {
    throw new Error('GitHub compare response has no commits array');
  }

  const lastCommit = body.commits.at(-1);
  const candidate = lastCommit
    ?? (status === 'behind' ? body.merge_base_commit : body.base_commit);

  if (candidate === undefined || candidate === null) return null;
  if (!isRecord(candidate)) throw new Error('GitHub compare response has an invalid commit');
  return candidate;
}

function parseRemoteMetadata(
  body: Record<string, unknown>,
  status: CompareStatus,
  localSha: string,
): Pick<CheckResult, 'remoteSha' | 'remoteMessage' | 'remoteDate'> {
  const candidate = remoteCommit(body, status);
  if (!candidate) {
    return status === 'identical' ? { remoteSha: localSha.slice(0, 7) } : {};
  }

  const sha = validSha(candidate.sha);
  if (!sha) throw new Error('GitHub compare response has an invalid commit SHA');

  const metadata: Pick<CheckResult, 'remoteSha' | 'remoteMessage' | 'remoteDate'> = {
    remoteSha: sha.slice(0, 7),
  };
  if (candidate.commit === undefined || candidate.commit === null) return metadata;
  if (!isRecord(candidate.commit)) throw new Error('GitHub compare response has invalid commit metadata');

  if (candidate.commit.message !== undefined) {
    if (typeof candidate.commit.message !== 'string') {
      throw new Error('GitHub compare response has an invalid commit message');
    }
    metadata.remoteMessage = candidate.commit.message.slice(0, 200);
  }

  const committer = candidate.commit.committer;
  if (committer !== undefined && committer !== null) {
    if (!isRecord(committer)) throw new Error('GitHub compare response has an invalid committer');
    if (committer.date !== undefined && committer.date !== null) {
      if (!validDate(committer.date)) {
        throw new Error('GitHub compare response has an invalid commit date');
      }
      metadata.remoteDate = committer.date;
    }
  }

  return metadata;
}

function parseChanges(body: Record<string, unknown>, status: CompareStatus): Change[] | undefined {
  if (status !== 'ahead') return undefined;
  if (!Array.isArray(body.commits)) {
    throw new Error('GitHub compare response has no commits array');
  }

  return body.commits.slice(-MAX_CHANGES).reverse().map((candidate: unknown) => {
    if (!isRecord(candidate)) throw new Error('GitHub compare response has an invalid commit');
    const sha = validSha(candidate.sha);
    if (!sha) throw new Error('GitHub compare response has an invalid commit SHA');
    if (!isRecord(candidate.commit)) {
      throw new Error('GitHub compare response has invalid commit metadata');
    }
    if (typeof candidate.commit.message !== 'string') {
      throw new Error('GitHub compare response has an invalid commit message');
    }

    const change: Change = {
      sha: sha.slice(0, 7),
      message: candidate.commit.message
        .slice(0, MAX_CHANGE_MESSAGE_LENGTH)
        .split(/[\r\n]/, 1)[0],
    };
    const committer = candidate.commit.committer;
    if (committer !== undefined && committer !== null) {
      if (!isRecord(committer)) throw new Error('GitHub compare response has an invalid committer');
      if (committer.date !== undefined && committer.date !== null) {
        if (!validDate(committer.date)) {
          throw new Error('GitHub compare response has an invalid commit date');
        }
        change.date = committer.date;
      }
    }
    return change;
  });
}

function decodeXmlText(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  };
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|apos|gt|lt|quot));/gi, (entity, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[String(name).toLowerCase()] ?? entity;
  });
}

function parseAtomFallback(
  xml: string,
  localSha: string,
  baseResult: Pick<CheckResult, 'installation' | 'localSha' | 'checkedAt'>,
): CheckResult {
  if (xml.length > MAX_ATOM_FEED_LENGTH) throw new Error('GitHub Atom feed is too large');

  const commits: Array<Change & { fullSha: string }> = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const entry = match[1];
    const sha = entry.match(/<id>[^<]*Commit\/([0-9a-f]{40})<\/id>/i)?.[1]?.toLowerCase();
    const title = entry.match(/<title>\s*([\s\S]*?)\s*<\/title>/i)?.[1];
    const updated = entry.match(/<updated>\s*([^<]+)\s*<\/updated>/i)?.[1]?.trim();
    if (!sha || title === undefined || (updated !== undefined && !validDate(updated))) {
      throw new Error('GitHub Atom feed has an invalid commit');
    }

    commits.push({
      fullSha: sha,
      sha: sha.slice(0, 7),
      message: decodeXmlText(title).replace(/\s+/g, ' ').trim().slice(0, MAX_CHANGE_MESSAGE_LENGTH),
      ...(updated ? { date: updated } : {}),
    });
  }

  if (commits.length === 0 || commits[0].message.length === 0) {
    throw new Error('GitHub Atom feed has no commits');
  }

  const latest = commits[0];
  const localIndex = commits.findIndex(commit => commit.fullSha === localSha);
  const status: CheckStatus = localIndex === 0
    ? 'current'
    : localIndex > 0
      ? 'available'
      : 'unknown';

  return {
    status,
    ...baseResult,
    remoteSha: latest.sha,
    remoteMessage: latest.message,
    ...(latest.date ? { remoteDate: latest.date } : {}),
    ...(status === 'available'
      ? { changes: commits.slice(0, localIndex).slice(0, MAX_CHANGES).map(({ fullSha: _fullSha, ...change }) => change) }
      : {}),
  };
}

export function createUpdateRouter(options: UpdateRouterOptions = {}): Router {
  const router = Router();
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const execFile = options.execFileSync ?? ((file, args, execOptions) => (
    nodeExecFileSync(file, args, execOptions)
  ));
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const githubToken = (options.env === undefined
    ? process.env.GITHUB_TOKEN
    : options.env.GITHUB_TOKEN)?.trim();

  let identity: Identity | undefined;
  let cache: CachedResult | null = null;
  let inFlight: Promise<CheckResult> | null = null;

  function resolveIdentity(): Identity {
    if (identity) return identity;

    const environmentSha = validSha(options.env === undefined
      ? process.env.FREELLMAPI_COMMIT_SHA
      : options.env.FREELLMAPI_COMMIT_SHA);
    const installMethod = options.env === undefined
      ? process.env.FREELLMAPI_INSTALL_METHOD
      : options.env.FREELLMAPI_INSTALL_METHOD;
    if (environmentSha && (installMethod === 'docker' || installMethod === 'desktop')) {
      identity = { sha: environmentSha, installation: installMethod };
      return identity;
    }

    try {
      const output = execFile('git', ['rev-parse', 'HEAD'], {
        cwd: options.cwd ?? process.cwd(),
        encoding: 'utf8',
        timeout: 5_000,
      });
      const gitSha = validSha(output.toString());
      if (gitSha) {
        identity = { sha: gitSha, installation: 'source' };
        return identity;
      }
    } catch {
      // A packaged or custom build may not have Git metadata.
    }

    identity = { sha: null, installation: 'unknown' };
    return identity;
  }

  async function performCheck(currentIdentity: Identity): Promise<CheckResult> {
    const checkedAtMs = now();
    const baseResult = {
      installation: currentIdentity.installation,
      localSha: currentIdentity.sha!.slice(0, 7),
      checkedAt: new Date(checkedAtMs).toISOString(),
    };
    const url = `https://api.github.com/repos/${REPOSITORY}/compare/${currentIdentity.sha}...main`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'freellmapi-update-checker',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 404) {
      return { status: 'unknown', ...baseResult };
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      const atomResponse = await fetchImpl(`https://github.com/${REPOSITORY}/commits/main.atom`, {
        headers: {
          Accept: 'application/atom+xml',
          'User-Agent': 'freellmapi-update-checker',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!atomResponse.ok) {
        throw new Error(`GitHub Atom request returned HTTP ${atomResponse.status}`);
      }
      return parseAtomFallback(await atomResponse.text(), currentIdentity.sha!, baseResult);
    }
    if (!response.ok) {
      throw new Error(`GitHub compare request returned HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    if (!isRecord(body)) throw new Error('GitHub compare response is not an object');
    const upstreamStatus = compareStatus(body.status);
    if (!upstreamStatus) throw new Error('GitHub compare response has an invalid status');

    return {
      status: mapCompareStatus(upstreamStatus),
      ...baseResult,
      ...parseRemoteMetadata(body, upstreamStatus, currentIdentity.sha!),
      ...(upstreamStatus === 'ahead' ? { changes: parseChanges(body, upstreamStatus) } : {}),
    };
  }

  function check(currentIdentity: Identity): Promise<CheckResult> {
    const currentTime = now();
    if (cache && currentTime - cache.cachedAt < CACHE_TTL_MS) {
      return Promise.resolve(cache.result);
    }
    if (inFlight) return inFlight;

    const request = performCheck(currentIdentity)
      .then((result) => {
        cache = { result, cachedAt: now() };
        return result;
      })
      .catch((error: unknown) => {
        logger.error('[update] GitHub compare check failed', error);
        throw error;
      })
      .finally(() => {
        if (inFlight === request) inFlight = null;
      });
    inFlight = request;
    return request;
  }

  router.get('/check', async (_req: Request, res: Response) => {
    const currentIdentity = resolveIdentity();
    if (!currentIdentity.sha) {
      return res.json({
        status: 'unsupported',
        installation: currentIdentity.installation,
        localSha: null,
        checkedAt: new Date(now()).toISOString(),
      } satisfies CheckResult);
    }

    try {
      return res.json(await check(currentIdentity));
    } catch {
      return res.status(502).json({
        error: {
          message: 'Unable to check for updates',
          type: 'upstream_error',
        },
      });
    }
  });

  router.get('/status', (_req: Request, res: Response) => {
    const currentIdentity = resolveIdentity();
    res.json({
      status: currentIdentity.sha ? (cache?.result.status ?? 'idle') : 'unsupported',
      installation: currentIdentity.installation,
      localSha: currentIdentity.sha?.slice(0, 7) ?? null,
      lastChecked: cache?.result.checkedAt ?? null,
    });
  });

  return router;
}

export const updateRouter = createUpdateRouter();
