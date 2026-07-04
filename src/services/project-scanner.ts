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
}

/**
 * Describe a single directory as a project: its basename + current git ref,
 * or null if the directory isn't a git repo/worktree. Used by `/repo <path>`
 * to label an explicitly given path that may sit outside the scanned roots
 * (the card's project list, by contrast, only covers the scan dirs).
 */
export function describeProjectDir(dir: string): { name: string; branch: string } | null {
  if (!isValidGitMarker(dir)) return null;
  return { name: basename(dir), branch: getGitRef(dir) };
}

/** `rev-parse --abbrev-ref HEAD` returns the literal string `HEAD` when
 *  detached — that's the signal to fall through to tag/SHA. */
function getGitRef(dir: string): string {
  const branch = runGit('rev-parse --abbrev-ref HEAD', dir);
  if (branch && branch !== 'HEAD') return branch;
  const tag = runGit('describe --tags --exact-match HEAD', dir);
  if (tag) return tag;
  const sha = runGit('rev-parse --short HEAD', dir);
  return sha || 'unknown';
}

function describeDetachedHead(worktreePath: string, headSha: string): string {
  const tag = runGit('describe --tags --exact-match HEAD', worktreePath);
  if (tag) return tag;
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

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

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

  logger.info(`Scanned ${baseDir}: found ${projects.length} project(s)`);
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
