/**
 * Cross-device dispatch repository requirements.
 *
 * The dispatcher names the repository by canonical remote URL (preferred) or a
 * local alias.  The receiving daemon resolves that identity against THIS
 * machine immediately before it starts a worker.  A platform capability table
 * can become stale; this module deliberately re-checks the directory, git
 * metadata, and remote URL at the point of use.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { config } from '../config.js';
import { scanMultipleProjects } from '../services/project-scanner.js';
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

/** Remember a repo selected locally. Invalid/non-git paths are never recorded. */
export function rememberRepoCapability(
  path: string,
  aliases: string[] = [],
  dataDir: string = config.session.dataDir,
  now: number = Date.now(),
): RepoCapabilityEntry | undefined {
  const inspected = inspectLocalRepo(path);
  if (!inspected.ok) return undefined;
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

/**
 * Resolve a repo requirement against persisted hints and live project scans.
 * Every matching stored entry is re-inspected before use, so deleted paths and
 * changed remotes fail closed instead of launching in the wrong project.
 */
export function resolveRepoRequirement(input: {
  requirement: string;
  scanDirs: string[];
  dataDir?: string;
}): RepoRequirementResolution {
  const requirement = input.requirement.trim();
  const dataDir = input.dataDir ?? config.session.dataDir;
  const wantedRemote = normalizeRepoRemote(requirement);
  let staleMatch: RepoRequirementResolution | undefined;
  let storedAliasRemote: string | undefined;

  for (const entry of readStore(dataDir).repos) {
    const matchedBy = requirementMatch(requirement, entry);
    if (!matchedBy) continue;
    if (matchedBy === 'alias') storedAliasRemote ??= entry.remoteIdentity;
    const inspected = inspectLocalRepo(entry.path);
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
    rememberRepoCapability(inspected.path, entry.aliases, dataDir);
    return { ...inspected, matchedBy, source: 'store' };
  }

  const scanDirs = [...new Set(input.scanDirs.map((dir) => resolve(dir)).filter((dir) => existsSync(dir)))];
  // A configured root may itself be a linked worktree. Prefer that exact
  // checkout before the recursive scanner expands the repository and sorts the
  // main worktree first; otherwise a bot pinned to a feature worktree would be
  // silently moved back to the main checkout merely because both share origin.
  for (const scanDir of scanDirs) {
    const inspected = inspectLocalRepo(scanDir);
    if (!inspected.ok) continue;
    const aliases = [basename(scanDir).toLowerCase(), basename(inspected.path).toLowerCase()];
    const matchedBy = wantedRemote
      ? (inspected.remoteIdentity === wantedRemote ? 'remote' : null)
      : (aliases.includes(requirement.toLowerCase()) &&
          (!storedAliasRemote || inspected.remoteIdentity === storedAliasRemote)
        ? 'alias'
        : null);
    if (!matchedBy) continue;
    rememberRepoCapability(inspected.path, aliases, dataDir);
    return { ...inspected, matchedBy, source: 'scan' };
  }

  const projects = scanDirs.length > 0 ? scanMultipleProjects(scanDirs, 3, { includeWorktrees: true }) : [];
  for (const project of projects) {
    const inspected = inspectLocalRepo(project.path);
    if (!inspected.ok) continue;
    const aliases = [project.name.toLowerCase(), basename(inspected.path).toLowerCase()];
    const matchedBy = wantedRemote
      ? (inspected.remoteIdentity === wantedRemote ? 'remote' : null)
      : (aliases.includes(requirement.toLowerCase()) &&
          (!storedAliasRemote || inspected.remoteIdentity === storedAliasRemote)
        ? 'alias'
        : null);
    if (!matchedBy) continue;
    rememberRepoCapability(inspected.path, aliases, dataDir);
    return { ...inspected, matchedBy, source: 'scan' };
  }

  return staleMatch ?? { ok: false, reason: 'not_found' };
}
