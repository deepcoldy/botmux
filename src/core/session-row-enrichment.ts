// src/core/session-row-enrichment.ts
//
// Git presentation metadata for dashboard session rows. Resolution happens in
// the central dashboard read-model (not in an HTTP request handler), so REST
// snapshots and SSE updates share one row shape.

import { execFile } from 'node:child_process';
import { basename } from 'node:path';

// ── Git repo info (per-cwd TTL cache) ─────────────────────────────────────

export type GitRepoInfo = {
  /** basename of the repo top-level dir. */
  repoName: string;
  /** Current branch; null for detached HEAD. */
  branch: string | null;
};

export interface GitRepoResolveOptions {
  /** Bypass a possibly stale positive cache at a known turn boundary. */
  force?: boolean;
}

const GIT_INFO_OK_TTL_MS = 60_000;
const GIT_INFO_MISS_TTL_MS = 300_000;
const GIT_TIMEOUT_MS = 1_500;
/** Concurrent git probes across all callers (a 99-session first poll must not
 *  fork-bomb the host). */
const GIT_MAX_CONCURRENT_PROBES = 8;

const gitInfoCache = new Map<string, {
  at: number;
  info: GitRepoInfo | null;
  sequence: number;
}>();
/** Dedup so a poll burst spawns at most one git probe per cwd. */
const gitInfoInflight = new Map<string, Promise<GitRepoInfo | null>>();
let gitProbeSequence = 0;

let gitProbesRunning = 0;
const gitProbeQueue: Array<() => void> = [];

async function withGitProbeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (gitProbesRunning >= GIT_MAX_CONCURRENT_PROBES) {
    await new Promise<void>((resolve) => gitProbeQueue.push(resolve));
  }
  gitProbesRunning++;
  try {
    return await fn();
  } finally {
    gitProbesRunning--;
    gitProbeQueue.shift()?.();
  }
}

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

async function probeGitRepoInfo(cwd: string): Promise<GitRepoInfo | null> {
  // One probe: line 1 = top-level path, line 2 = branch ('HEAD' when detached).
  const out = await runGit(['-C', cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD']);
  const [top = '', branchRaw = ''] = out.split('\n').map((l) => l.trim());
  if (!top) return null;
  return {
    repoName: basename(top) || top,
    branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
  };
}

/** Resolve repoName/branch for a session cwd; null when not a git repo. Never throws. */
export async function getGitRepoInfo(
  cwd: string,
  options: GitRepoResolveOptions = {},
): Promise<GitRepoInfo | null> {
  const dir = cwd.trim();
  if (!dir) return null;
  const now = Date.now();
  const hit = gitInfoCache.get(dir);
  if (
    !options.force
    && hit
    && now - hit.at < (hit.info ? GIT_INFO_OK_TTL_MS : GIT_INFO_MISS_TTL_MS)
  ) {
    return hit.info;
  }
  const inflight = gitInfoInflight.get(dir);
  if (!options.force && inflight) return inflight;
  const sequence = ++gitProbeSequence;
  const p = (async (): Promise<GitRepoInfo | null> => {
    try {
      return await withGitProbeSlot(() => probeGitRepoInfo(dir));
    } catch {
      return null;
    }
  })();
  gitInfoInflight.set(dir, p);
  try {
    const info = await p;
    const current = gitInfoCache.get(dir);
    // A force refresh started later must remain authoritative even if an older
    // probe happens to finish after it.
    if (!current || sequence >= current.sequence) {
      gitInfoCache.set(dir, { at: Date.now(), info, sequence });
    }
    return info;
  } finally {
    if (gitInfoInflight.get(dir) === p) gitInfoInflight.delete(dir);
  }
}

/** Test hook: clear the resolver cache. */
export function clearSessionRowEnrichmentCaches(): void {
  gitInfoCache.clear();
}
