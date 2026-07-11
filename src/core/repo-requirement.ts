/**
 * Cross-device dispatch repository requirements.
 *
 * The dispatcher names the repository by canonical remote URL (preferred) or a
 * local alias.  The receiving daemon resolves that identity against THIS
 * machine immediately before it starts a worker.  A platform capability table
 * can become stale; this module deliberately re-checks the directory, git
 * metadata, and remote URL at the point of use.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, stat as statAsync } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export const DISPATCH_REPO_HEADER = '[botmux-dispatch v1]';

export interface DispatchRepoRequirement {
  taskId: string;
  repo: string;
}

export interface ParsedDispatchRepoRequirement extends DispatchRepoRequirement {
  /** Human/agent-visible task text with the machine block removed. */
  content: string;
}

export interface RepoCapabilityEntry {
  path: string;
  remoteUrl: string;
  remoteIdentity: string;
  aliases: string[];
  updatedAt: number;
}

interface RepoCapabilityFile {
  version: 1;
  repos: RepoCapabilityEntry[];
}

export type RepoRequirementResolution =
  | {
      ok: true;
      path: string;
      remoteUrl: string;
      remoteIdentity: string;
      matchedBy: 'remote' | 'alias';
      source: 'store' | 'scan';
    }
  | {
      ok: false;
      reason: 'not_found' | 'stale_path' | 'not_git' | 'missing_remote' | 'remote_mismatch';
      detail?: string;
      stalePath?: string;
    };

interface InspectedRepo {
  ok: true;
  path: string;
  remoteUrl: string;
  remoteIdentity: string;
}

type RepoInspection = InspectedRepo | {
  ok: false;
  reason: 'stale_path' | 'not_git' | 'missing_remote';
  detail?: string;
};

function oneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

/** Build the machine block appended to a dispatch post. */
export function formatDispatchRepoRequirement(input: DispatchRepoRequirement): string {
  const taskId = oneLine(input.taskId);
  const repo = oneLine(input.repo);
  if (!taskId) throw new Error('dispatch repo requirement needs taskId');
  if (!repo) throw new Error('dispatch repo requirement needs repo');
  return `${DISPATCH_REPO_HEADER}\ntaskId: ${taskId}\nrepo: ${repo}`;
}

/**
 * Parse and remove the trailing machine block.  Dispatch always appends this
 * block after the human brief/division-of-labour paragraphs, so stripping from
 * the header to the end cannot eat task content.
 */
export function parseDispatchRepoRequirement(text: string | undefined): ParsedDispatchRepoRequirement | null {
  if (!text?.includes(DISPATCH_REPO_HEADER)) return null;
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === DISPATCH_REPO_HEADER) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const fields = new Map<string, string>();
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const taskId = fields.get('taskid')?.trim();
  const repo = fields.get('repo')?.trim();
  if (!taskId || !repo) return null;
  return {
    taskId,
    repo,
    content: lines.slice(0, start).join('\n').trimEnd(),
  };
}

function stripRemoteSuffix(pathname: string): string {
  return pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
}

/**
 * Normalize common git remote spellings into `host/path`.
 *
 * Examples:
 *   git@github.com:org/repo.git -> github.com/org/repo
 *   https://github.com/org/repo.git -> github.com/org/repo
 *   ssh://git@github.com/org/repo -> github.com/org/repo
 */
export function normalizeRepoRemote(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  const scp = /^(?:[^@\s]+@)?([^:\s/]+):(.+)$/.exec(raw);
  if (scp && !raw.includes('://')) {
    const path = stripRemoteSuffix(scp[2]);
    return path ? `${scp[1].toLowerCase()}/${path}` : null;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'file:') {
        const path = stripRemoteSuffix(url.pathname);
        return path ? `file/${path}` : null;
      }
      const host = url.host.toLowerCase();
      const path = stripRemoteSuffix(url.pathname);
      return host && path ? `${host}/${path}` : null;
    } catch {
      return null;
    }
  }

  // Also accept a scheme-less host/path supplied by a platform UI.
  const hostPath = /^([^/\s]+\.[^/\s]+)\/(.+)$/.exec(raw);
  if (hostPath) {
    const path = stripRemoteSuffix(hostPath[2]);
    return path ? `${hostPath[1].toLowerCase()}/${path}` : null;
  }
  return null;
}

function runGit(path: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', path, ...args], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function runGitAsync(path: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolveResult) => {
    execFile('git', ['-C', path, ...args], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout) => {
      resolveResult(error ? null : stdout.trim());
    });
  });
}

/** Re-check a candidate at the point of dispatch; persisted entries are hints. */
export function inspectLocalRepo(path: string): RepoInspection {
  const candidate = resolve(path);
  try {
    if (!statSync(candidate).isDirectory()) {
      return { ok: false, reason: 'stale_path', detail: 'path is not a directory' };
    }
  } catch {
    return { ok: false, reason: 'stale_path', detail: 'path does not exist' };
  }

  const topLevel = runGit(candidate, ['rev-parse', '--show-toplevel']);
  if (!topLevel) return { ok: false, reason: 'not_git', detail: 'not a git repository' };
  const remoteUrl = runGit(topLevel, ['remote', 'get-url', 'origin']);
  if (!remoteUrl) return { ok: false, reason: 'missing_remote', detail: 'origin remote is missing' };
  const remoteIdentity = normalizeRepoRemote(remoteUrl);
  if (!remoteIdentity) return { ok: false, reason: 'missing_remote', detail: 'origin remote is not recognizable' };
  // Persist/display only the credential-free canonical identity. A git remote
  // can legally contain an embedded token; it must never leak into the store,
  // ledger, logs, or group protocol block.
  return { ok: true, path: resolve(topLevel), remoteUrl: remoteIdentity, remoteIdentity };
}

/** Async equivalent used on the daemon message path so git cannot stall other sessions. */
export async function inspectLocalRepoAsync(path: string, gitTimeoutMs: number = 1_500): Promise<RepoInspection> {
  const candidate = resolve(path);
  try {
    if (!(await statAsync(candidate)).isDirectory()) {
      return { ok: false, reason: 'stale_path', detail: '路径不是目录' };
    }
  } catch {
    return { ok: false, reason: 'stale_path', detail: '路径不存在' };
  }

  const topLevel = await runGitAsync(candidate, ['rev-parse', '--show-toplevel'], gitTimeoutMs);
  if (!topLevel) return { ok: false, reason: 'not_git', detail: '不是 Git 仓库' };
  const remoteUrl = await runGitAsync(topLevel, ['remote', 'get-url', 'origin'], gitTimeoutMs);
  if (!remoteUrl) return { ok: false, reason: 'missing_remote', detail: '没有配置 origin 地址' };
  const remoteIdentity = normalizeRepoRemote(remoteUrl);
  if (!remoteIdentity) return { ok: false, reason: 'missing_remote', detail: '无法识别 origin 地址' };
  return { ok: true, path: resolve(topLevel), remoteUrl: remoteIdentity, remoteIdentity };
}

function storePath(dataDir: string): string {
  return join(dataDir, 'verified-delivery', 'repo-capabilities.json');
}

function readStore(dataDir: string): RepoCapabilityFile {
  const path = storePath(dataDir);
  if (!existsSync(path)) return { version: 1, repos: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RepoCapabilityFile>;
    if (!Array.isArray(parsed.repos)) return { version: 1, repos: [] };
    return {
      version: 1,
      repos: parsed.repos.filter((entry): entry is RepoCapabilityEntry =>
        !!entry &&
        typeof entry.path === 'string' &&
        typeof entry.remoteUrl === 'string' &&
        typeof entry.remoteIdentity === 'string' &&
        Array.isArray(entry.aliases) &&
        entry.aliases.every((alias) => typeof alias === 'string') &&
        typeof entry.updatedAt === 'number'),
    };
  } catch {
    return { version: 1, repos: [] };
  }
}

function writeStore(dataDir: string, file: RepoCapabilityFile): void {
  mkdirSync(join(dataDir, 'verified-delivery'), { recursive: true });
  atomicWriteFileSync(storePath(dataDir), JSON.stringify(file, null, 2) + '\n');
}

function rememberInspectedRepoCapability(
  inspected: InspectedRepo,
  aliases: string[] = [],
  dataDir: string = config.session.dataDir,
  now: number = Date.now(),
): RepoCapabilityEntry {
  const file = readStore(dataDir);
  const normalizedAliases = [...new Set([
    basename(inspected.path),
    ...aliases,
  ].map((alias) => alias.trim().toLowerCase()).filter(Boolean))];
  const prior = file.repos.find((entry) => resolve(entry.path) === inspected.path);
  const entry: RepoCapabilityEntry = {
    path: inspected.path,
    remoteUrl: inspected.remoteUrl,
    remoteIdentity: inspected.remoteIdentity,
    aliases: [...new Set([...(prior?.aliases ?? []), ...normalizedAliases])],
    updatedAt: now,
  };
  if (
    prior &&
    prior.remoteIdentity === entry.remoteIdentity &&
    prior.remoteUrl === entry.remoteUrl &&
    prior.aliases.length === entry.aliases.length &&
    prior.aliases.every((alias) => entry.aliases.includes(alias)) &&
    now - prior.updatedAt < 10 * 60_000
  ) {
    return prior;
  }
  const repos = file.repos.filter((item) => resolve(item.path) !== inspected.path);
  repos.push(entry);
  writeStore(dataDir, { version: 1, repos });
  return entry;
}

/** Remember a repo selected locally. Invalid/non-git paths are never recorded. */
export function rememberRepoCapability(
  path: string,
  aliases: string[] = [],
  dataDir: string = config.session.dataDir,
  now: number = Date.now(),
): RepoCapabilityEntry | undefined {
  const inspected = inspectLocalRepo(path);
  if (!inspected.ok) return undefined;
  return rememberInspectedRepoCapability(inspected, aliases, dataDir, now);
}

export function listRepoCapabilities(dataDir: string = config.session.dataDir): RepoCapabilityEntry[] {
  return readStore(dataDir).repos;
}

function requirementMatch(
  requirement: string,
  entry: Pick<RepoCapabilityEntry, 'remoteIdentity' | 'aliases'>,
): 'remote' | 'alias' | null {
  const remoteIdentity = normalizeRepoRemote(requirement);
  if (remoteIdentity) return entry.remoteIdentity === remoteIdentity ? 'remote' : null;
  const alias = requirement.trim().toLowerCase();
  return alias && entry.aliases.includes(alias) ? 'alias' : null;
}

export interface RepoRequirementResolveLimits {
  maxDepth?: number;
  maxDirectories?: number;
  maxCandidates?: number;
  timeoutMs?: number;
  gitTimeoutMs?: number;
  inspectConcurrency?: number;
}

interface ResolvedRepoRequirementInput {
  requirement: string;
  scanDirs: string[];
  dataDir?: string;
  limits?: RepoRequirementResolveLimits;
}

const DEFAULT_ASYNC_RESOLVE_LIMITS = {
  maxDepth: 3,
  maxDirectories: 2_000,
  maxCandidates: 64,
  timeoutMs: 5_000,
  gitTimeoutMs: 1_500,
  inspectConcurrency: 8,
} as const;

const REPO_SCAN_SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist']);

async function discoverRepoCandidates(
  roots: string[],
  limits: Required<RepoRequirementResolveLimits>,
  deadline: number,
): Promise<{ paths: string[]; truncated: boolean }> {
  const queue = roots.map((path) => ({ path, depth: 0 }));
  const seen = new Set<string>();
  const paths: string[] = [];
  let directories = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (Date.now() >= deadline || directories >= limits.maxDirectories || paths.length >= limits.maxCandidates) {
      truncated = true;
      break;
    }
    const next = queue.shift()!;
    const dir = resolve(next.path);
    if (seen.has(dir)) continue;
    seen.add(dir);
    directories += 1;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.name === '.git')) {
      paths.push(dir);
      continue;
    }
    if (next.depth >= limits.maxDepth) continue;
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        REPO_SCAN_SKIP_DIRS.has(entry.name)
      ) continue;
      queue.push({ path: join(dir, entry.name), depth: next.depth + 1 });
    }
  }

  return { paths, truncated };
}

function asyncResolveLimits(input?: RepoRequirementResolveLimits): Required<RepoRequirementResolveLimits> {
  return {
    maxDepth: Math.max(0, input?.maxDepth ?? DEFAULT_ASYNC_RESOLVE_LIMITS.maxDepth),
    maxDirectories: Math.max(1, input?.maxDirectories ?? DEFAULT_ASYNC_RESOLVE_LIMITS.maxDirectories),
    maxCandidates: Math.max(1, input?.maxCandidates ?? DEFAULT_ASYNC_RESOLVE_LIMITS.maxCandidates),
    timeoutMs: Math.max(100, input?.timeoutMs ?? DEFAULT_ASYNC_RESOLVE_LIMITS.timeoutMs),
    gitTimeoutMs: Math.max(100, input?.gitTimeoutMs ?? DEFAULT_ASYNC_RESOLVE_LIMITS.gitTimeoutMs),
    inspectConcurrency: Math.max(1, input?.inspectConcurrency ?? DEFAULT_ASYNC_RESOLVE_LIMITS.inspectConcurrency),
  };
}

function boundedGitTimeout(deadline: number, configuredMs: number): number {
  const remaining = Math.max(100, deadline - Date.now());
  // One inspection performs two git commands in sequence.
  return Math.max(100, Math.min(configuredMs, Math.floor(remaining / 2)));
}

/**
 * Daemon-safe resolver. Filesystem traversal and git subprocesses are async,
 * bounded, and concurrent, so one large project root cannot freeze every
 * session owned by the receiving bot.
 */
export async function resolveRepoRequirement(input: ResolvedRepoRequirementInput): Promise<RepoRequirementResolution> {
  const requirement = input.requirement.trim();
  const dataDir = input.dataDir ?? config.session.dataDir;
  const wantedRemote = normalizeRepoRemote(requirement);
  const limits = asyncResolveLimits(input.limits);
  const deadline = Date.now() + limits.timeoutMs;
  let staleMatch: RepoRequirementResolution | undefined;
  let storedAliasRemote: string | undefined;

  for (const entry of readStore(dataDir).repos) {
    if (Date.now() >= deadline) break;
    const matchedBy = requirementMatch(requirement, entry);
    if (!matchedBy) continue;
    if (matchedBy === 'alias') storedAliasRemote ??= entry.remoteIdentity;
    const inspected = await inspectLocalRepoAsync(entry.path, boundedGitTimeout(deadline, limits.gitTimeoutMs));
    if (!inspected.ok) {
      staleMatch = { ok: false, reason: inspected.reason, detail: inspected.detail, stalePath: entry.path };
      continue;
    }
    const expectedRemote = wantedRemote ?? entry.remoteIdentity;
    if (inspected.remoteIdentity !== expectedRemote) {
      staleMatch = {
        ok: false,
        reason: 'remote_mismatch',
        detail: `expected ${expectedRemote}, found ${inspected.remoteIdentity}`,
        stalePath: entry.path,
      };
      continue;
    }
    rememberInspectedRepoCapability(inspected, entry.aliases, dataDir);
    return { ...inspected, matchedBy, source: 'store' };
  }

  const scanDirs = [...new Set(input.scanDirs.map((dir) => resolve(dir)).filter((dir) => existsSync(dir)))];
  // A configured root may itself be a linked worktree. Check that exact path
  // first so a recursive scan cannot silently move the task to its main checkout.
  for (const scanDir of scanDirs) {
    if (Date.now() >= deadline) break;
    const inspected = await inspectLocalRepoAsync(scanDir, boundedGitTimeout(deadline, limits.gitTimeoutMs));
    if (!inspected.ok) continue;
    const aliases = [basename(scanDir).toLowerCase(), basename(inspected.path).toLowerCase()];
    const matchedBy = wantedRemote
      ? (inspected.remoteIdentity === wantedRemote ? 'remote' : null)
      : (aliases.includes(requirement.toLowerCase()) &&
          (!storedAliasRemote || inspected.remoteIdentity === storedAliasRemote)
        ? 'alias'
        : null);
    if (!matchedBy) continue;
    rememberInspectedRepoCapability(inspected, aliases, dataDir);
    return { ...inspected, matchedBy, source: 'scan' };
  }

  const discovered = await discoverRepoCandidates(scanDirs, limits, deadline);
  const rootSet = new Set(scanDirs);
  const candidates = discovered.paths.filter((path) => !rootSet.has(resolve(path)));
  for (let offset = 0; offset < candidates.length && Date.now() < deadline; offset += limits.inspectConcurrency) {
    const batch = candidates.slice(offset, offset + limits.inspectConcurrency);
    const timeoutMs = boundedGitTimeout(deadline, limits.gitTimeoutMs);
    const inspectedBatch = await Promise.all(batch.map((path) => inspectLocalRepoAsync(path, timeoutMs)));
    for (let i = 0; i < inspectedBatch.length; i++) {
      const inspected = inspectedBatch[i]!;
      if (!inspected.ok) continue;
      const candidate = batch[i]!;
      const aliases = [basename(candidate).toLowerCase(), basename(inspected.path).toLowerCase()];
      const matchedBy = wantedRemote
        ? (inspected.remoteIdentity === wantedRemote ? 'remote' : null)
        : (aliases.includes(requirement.toLowerCase()) &&
            (!storedAliasRemote || inspected.remoteIdentity === storedAliasRemote)
          ? 'alias'
          : null);
      if (!matchedBy) continue;
      rememberInspectedRepoCapability(inspected, aliases, dataDir);
      return { ...inspected, matchedBy, source: 'scan' };
    }
  }

  const timedOut = Date.now() >= deadline;
  return staleMatch ?? {
    ok: false,
    reason: 'not_found',
    ...((discovered.truncated || timedOut) ? { detail: '项目扫描达到上限；请先在该设备选择一次项目完成登记' } : {}),
  };
}
