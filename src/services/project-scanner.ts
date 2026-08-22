import { execSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { logger } from '../utils/logger.js';

/** A `.git` entry that's a regular file (worktree gitlink) or a directory
 *  containing `HEAD`. An empty `.git/` is rejected so the scanner keeps
 *  recursing past stray markers like `/root/.git`. */
function isValidGitMarker(parentDir: string): boolean {
  const gitPath = join(parentDir, '.git');
  let st;
  try { st = statSync(gitPath); } catch { return false; }
  if (st.isFile()) return true;
  if (st.isDirectory()) return existsSync(join(gitPath, 'HEAD'));
  return false;
}

function runGit(args: string, cwd: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

export interface ProjectInfo {
  name: string;
  path: string;
  type: 'repo' | 'worktree';
  branch: string;
}

export interface ProjectScanOptions {
  includeWorktrees?: boolean;
  /** Hard cap on directories visited during a single scan. Guards against a
   *  misconfigured scan root (e.g. `~`) turning the synchronous walk into a
   *  minutes-long event-loop stall. Defaults to DEFAULT_MAX_SCAN_DIRS. */
  maxScanDirs?: number;
  /** Wall-clock budget (ms) for a single scan, checked between filesystem
   *  calls. A dir-count cap alone doesn't bound a "repo storm" root where
   *  each repo spawns a slow `git` subprocess; this stops the walk once the
   *  budget is spent. Defaults to DEFAULT_MAX_SCAN_MS. Note: this cannot
   *  interrupt a single syscall already blocked in the kernel (e.g. a
   *  readdir that hangs on a protected/stale directory) — only the space
   *  between calls. Narrowing the scan root remains the real fix. */
  maxScanMs?: number;
  /** Invoked once, after the walk, if either budget (dirs or wall-clock) was
   *  hit — meaning the returned list may be incomplete. Lets a caller surface a
   *  "scan root too large / narrow it" hint to the user instead of silently
   *  showing a partial list or a misleading "no repos found". Not called when
   *  the scan completes within budget. `reason` says which cap tripped. */
  onBudgetExceeded?: (info: { reason: 'dirs' | 'time'; dirsVisited: number; baseDir: string }) => void;
}

/** Upper bound on directories a single `scanProjects` walk will visit before
 *  bailing out. `scanProjects` is fully synchronous (readdirSync + a `git`
 *  subprocess per repo), so an unbounded walk over a huge root such as the
 *  home directory blocks the daemon's event loop — no repo card is ever sent
 *  and the whole bot appears hung. 4000 dirs comfortably covers a normal
 *  projects root while capping the worst case. */
export const DEFAULT_MAX_SCAN_DIRS = 4000;

/** Wall-clock budget for one scan. A normal projects root scans in well under
 *  a second; anything past a few seconds means the root is misconfigured
 *  (pointed at `~` or similar). Bailing keeps the daemon responsive. */
export const DEFAULT_MAX_SCAN_MS = 4000;

/**
 * Describe a single directory as a project: the main worktree basename +
 * current git ref, or null if the directory isn't a git repo/worktree. Using
 * the main worktree name preserves the picker label for an explicitly selected
 * linked worktree without recursively scanning the configured roots first.
 */
export function describeProjectDir(dir: string): { name: string; branch: string } | null {
  if (!isValidGitMarker(dir)) return null;
  const worktreeList = runGit('worktree list --porcelain', dir);
  const mainWorktree = worktreeList
    ?.split('\n')
    .find(line => line.startsWith('worktree '))
    ?.slice('worktree '.length);
  return {
    name: mainWorktree ? basename(mainWorktree) : basename(dir),
    branch: getGitRef(dir),
  };
}

/** `rev-parse --abbrev-ref HEAD` returns the literal string `HEAD` when
 *  detached — that's the signal to fall back to the short SHA.
 *
 *  We deliberately do NOT run `git describe --tags --exact-match HEAD` here:
 *  it only returns something when HEAD sits exactly on a tagged commit (a rare
 *  "checked out a release tag" case), yet to decide that it must load every tag
 *  ref into a map first — on a repo with a huge tag count (~100k observed) that
 *  single call costs 2–6s. The common detached case (a worktree parked on an
 *  ordinary dev commit) matches no tag and pays that cost for nothing, then
 *  falls back to the SHA anyway. So skip straight to the short SHA. */
function getGitRef(dir: string): string {
  const branch = runGit('rev-parse --abbrev-ref HEAD', dir);
  if (branch && branch !== 'HEAD') return branch;
  const sha = runGit('rev-parse --short HEAD', dir);
  return sha || 'unknown';
}

/** The worktree-list porcelain already hands us the detached HEAD's full SHA,
 *  so return its short form directly — no `git` subprocess, and (same reasoning
 *  as getGitRef) no expensive tag describe on huge-tag repos. */
function describeDetachedHead(_worktreePath: string, headSha: string): string {
  return headSha ? headSha.slice(0, 7) : 'unknown';
}

/** Sibling worktrees of one repo share a common-dir — used as the dedup
 *  key so the scanner doesn't double-register when main + linked sit
 *  side-by-side in the scan root. */
function getGitCommonDir(dir: string): string {
  const out = runGit('rev-parse --git-common-dir', dir);
  return out ? resolve(dir, out) : dir;
}

/** Index 0 of `git worktree list --porcelain` is always the main worktree.
 *  All entries share its basename as `name`, so display stays stable
 *  regardless of which sibling readdir hits first. */
function scanRepoFromAnyWorktree(anyWorktreePath: string, options: ProjectScanOptions = {}): ProjectInfo[] {
  const fallback: ProjectInfo[] = [{
    name: basename(anyWorktreePath),
    path: anyWorktreePath,
    type: 'repo',
    branch: getGitRef(anyWorktreePath),
  }];

  const output = runGit('worktree list --porcelain', anyWorktreePath);
  if (output === null) return fallback;

  const entries: { path: string; branch: string }[] = [];
  let currentPath = '';
  let currentHead = '';
  let currentBranch = '';
  // runGit trims the trailing newline; append a sentinel so the final
  // entry hits the empty-line flush branch below.
  const lines = output.split('\n');
  lines.push('');
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      currentHead = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      currentBranch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line === '') {
      if (currentPath) {
        const ref = currentBranch
          || (currentHead ? describeDetachedHead(currentPath, currentHead) : 'unknown');
        entries.push({ path: currentPath, branch: ref });
      }
      currentPath = '';
      currentHead = '';
      currentBranch = '';
    }
  }
  if (entries.length === 0) return fallback;

  const repoName = basename(entries[0]!.path);
  const includeWorktrees = options.includeWorktrees !== false;
  return entries
    .filter((_wt, i) => includeWorktrees || i === 0)
    .map((wt, i) => ({
    name: repoName,
    path: wt.path,
    type: i === 0 ? 'repo' : 'worktree',
    branch: wt.branch,
  }));
}

function compareProjects(a: ProjectInfo, b: ProjectInfo): number {
  if (a.type !== b.type) return a.type === 'repo' ? -1 : 1;
  return a.name.localeCompare(b.name) || a.branch.localeCompare(b.branch);
}

/**
 * Scan a directory for git repositories and their worktrees.
 */
export function scanProjects(baseDir: string, maxDepth: number = 3, options: ProjectScanOptions = {}): ProjectInfo[] {
  const projects: ProjectInfo[] = [];
  const seenRepos = new Set<string>();   // by git-common-dir
  const seenPaths = new Set<string>();   // by absolute path
  const maxScanDirs = options.maxScanDirs ?? DEFAULT_MAX_SCAN_DIRS;
  const maxScanMs = options.maxScanMs ?? DEFAULT_MAX_SCAN_MS;
  const deadline = Date.now() + maxScanMs;
  let dirsVisited = 0;
  let budgetReason: 'dirs' | 'time' | null = null;

  function overBudget(): boolean {
    if (dirsVisited >= maxScanDirs) { budgetReason ??= 'dirs'; return true; }
    if (Date.now() >= deadline) { budgetReason ??= 'time'; return true; }
    return false;
  }

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    if (overBudget()) return;
    dirsVisited++;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    if (entries.includes('.git') && isValidGitMarker(dir)) {
      const commonDir = getGitCommonDir(dir);
      if (seenRepos.has(commonDir)) return;
      seenRepos.add(commonDir);

      for (const p of scanRepoFromAnyWorktree(dir, options)) {
        if (!seenPaths.has(p.path)) {
          seenPaths.add(p.path);
          projects.push(p);
        }
      }
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'vendor' || entry === 'dist') continue;
      if (overBudget()) return;
      const fullPath = join(dir, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          walk(fullPath, depth + 1);
        }
      } catch {
        // permission denied or broken symlink
      }
    }
  }

  walk(baseDir, 0);
  projects.sort(compareProjects);

  if (budgetReason) {
    const limit = budgetReason === 'dirs' ? `${maxScanDirs}-dir` : `${maxScanMs}ms`;
    logger.warn(`Scanned ${baseDir}: hit ${limit} budget after ${dirsVisited} dirs, found ${projects.length} project(s) so far — results may be incomplete. Configure a narrower workingDirs to avoid scanning a huge root.`);
    options.onBudgetExceeded?.({ reason: budgetReason, dirsVisited, baseDir });
  } else {
    logger.info(`Scanned ${baseDir}: found ${projects.length} project(s)`);
  }
  return projects;
}

/**
 * Scan multiple directories and deduplicate by path.
 */
export function scanMultipleProjects(baseDirs: string[], maxDepth: number = 3, options: ProjectScanOptions = {}): ProjectInfo[] {
  const seen = new Set<string>();
  const merged: ProjectInfo[] = [];

  for (const dir of baseDirs) {
    for (const project of scanProjects(dir, maxDepth, options)) {
      if (!seen.has(project.path)) {
        seen.add(project.path);
        merged.push(project);
      }
    }
  }

  merged.sort(compareProjects);
  return merged;
}
