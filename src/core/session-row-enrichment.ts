// src/core/session-row-enrichment.ts
//
// Presentation enrichment for GET /api/sessions rows: bot avatar (from the
// daemon's bots-info.json, mtime-cached) + git repo name/branch (resolved
// from workingDir, TTL-cached). Stamped in the dashboard handler so every
// consumer (board, Desktop sidebar) shares one additive row shape; rows from
// older daemons simply never carry the new fields.

import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

// ── Bot avatar map (bots-info.json, mtime-cached) ─────────────────────────

type BotsInfoEntry = {
  larkAppId?: string;
  botAvatarUrl?: string | null;
};

let avatarCache: { path: string; mtimeMs: number; map: Map<string, string> } | null = null;

/** larkAppId → bot avatar URL from bots-info.json; empty map when unreadable. */
export function getBotAvatarByAppId(dataDir: string): Map<string, string> {
  const path = join(dataDir, 'bots-info.json');
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // File missing — cache the empty map keyed on mtime -1.
  }
  if (avatarCache && avatarCache.path === path && avatarCache.mtimeMs === mtimeMs) {
    return avatarCache.map;
  }
  const map = new Map<string, string>();
  if (mtimeMs >= 0) {
    try {
      const entries = JSON.parse(readFileSync(path, 'utf8')) as BotsInfoEntry[];
      if (Array.isArray(entries)) {
        for (const e of entries) {
          const appId = typeof e?.larkAppId === 'string' ? e.larkAppId : '';
          const url = typeof e?.botAvatarUrl === 'string' ? e.botAvatarUrl.trim() : '';
          if (appId && url) map.set(appId, url);
        }
      }
    } catch {
      /* unreadable → empty map */
    }
  }
  avatarCache = { path, mtimeMs, map };
  return map;
}

// ── Git repo info (per-cwd TTL cache) ─────────────────────────────────────

export type GitRepoInfo = {
  /** basename of the repo top-level dir. */
  repoName: string;
  /** Current branch; null for detached HEAD. */
  branch: string | null;
};

const GIT_INFO_OK_TTL_MS = 60_000;
const GIT_INFO_MISS_TTL_MS = 300_000;
const GIT_TIMEOUT_MS = 1_500;
/** Concurrent git probes across all callers (a 99-session first poll must not
 *  fork-bomb the host). */
const GIT_MAX_CONCURRENT_PROBES = 8;

const gitInfoCache = new Map<string, { at: number; info: GitRepoInfo | null }>();
/** Dedup so a poll burst spawns at most one git probe per cwd. */
const gitInfoInflight = new Map<string, Promise<GitRepoInfo | null>>();

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
export async function getGitRepoInfo(cwd: string): Promise<GitRepoInfo | null> {
  const dir = cwd.trim();
  if (!dir) return null;
  const now = Date.now();
  const hit = gitInfoCache.get(dir);
  if (hit && now - hit.at < (hit.info ? GIT_INFO_OK_TTL_MS : GIT_INFO_MISS_TTL_MS)) {
    return hit.info;
  }
  const inflight = gitInfoInflight.get(dir);
  if (inflight) return inflight;
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
    gitInfoCache.set(dir, { at: Date.now(), info });
    return info;
  } finally {
    gitInfoInflight.delete(dir);
  }
}

// ── Row stamping ──────────────────────────────────────────────────────────

type RowWithEnrichmentHints = {
  larkAppId?: string;
  workingDir?: string;
};

/** Test hook: clear both caches. */
export function clearSessionRowEnrichmentCaches(): void {
  avatarCache = null;
  gitInfoCache.clear();
}

/**
 * Stamp botAvatarUrl + repoName + gitBranch onto session rows. Best-effort
 * and additive: avatars come from bots-info.json (sync, cheap); git info is
 * probed per workingDir with a TTL cache. A total time budget keeps a wedged
 * filesystem from stalling /api/sessions — late probes still land in the
 * cache and show up on the next poll.
 */
export async function enrichSessionRowsForPresentation<T extends RowWithEnrichmentHints>(
  rows: readonly T[],
  dataDir: string,
): Promise<Array<T & { botAvatarUrl?: string; repoName?: string; gitBranch?: string }>> {
  const avatars = getBotAvatarByAppId(dataDir);
  const withAvatar = rows.map((row) => {
    const botAvatarUrl = row.larkAppId ? avatars.get(row.larkAppId) : undefined;
    return botAvatarUrl ? { ...row, botAvatarUrl } : row;
  });
  const withGit = withAvatar.map(async (row) => {
    if (!row.workingDir) return row;
    const git = await getGitRepoInfo(row.workingDir);
    if (!git) return row;
    return {
      ...row,
      ...(git.repoName ? { repoName: git.repoName } : {}),
      ...(git.branch ? { gitBranch: git.branch } : {}),
    };
  });
  const GIT_BUDGET_MS = 2_500;
  return Promise.race([
    Promise.all(withGit),
    new Promise<typeof withAvatar>((resolve) =>
      setTimeout(() => resolve(withAvatar), GIT_BUDGET_MS),
    ),
  ]);
}
