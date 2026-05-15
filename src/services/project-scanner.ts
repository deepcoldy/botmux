import { execSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * A directory's `.git` entry is a valid git marker when:
 *   - it's a regular file (worktree gitlink, content: `gitdir: <path>`), OR
 *   - it's a directory containing `HEAD` (the minimum a real repo has).
 *
 * Returning false for an empty `.git/` dir prevents the scanner from
 * mistaking a stray empty marker (e.g. `/root/.git`) for a single repo and
 * skipping the entire subtree below.
 */
function isValidGitMarker(parentDir: string): boolean {
  const gitPath = join(parentDir, '.git');
  let st;
  try { st = statSync(gitPath); } catch { return false; }
  if (st.isFile()) return true;
  if (st.isDirectory()) return existsSync(join(gitPath, 'HEAD'));
  return false;
}

export interface ProjectInfo {
  name: string;       // display name
  path: string;       // absolute path
  type: 'repo' | 'worktree';
  branch: string;     // current branch name
}

/** zsh-prompt-style ref resolution: branch → tag → short SHA → 'unknown'.
 *  `git rev-parse --abbrev-ref HEAD` returns the literal string `HEAD`
 *  when detached, which is the signal to fall through to tag/SHA lookup. */
function getGitRef(dir: string): string {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: dir, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (branch && branch !== 'HEAD') return branch;
  } catch { /* fall through */ }
  try {
    const tag = execSync('git describe --tags --exact-match HEAD', {
      cwd: dir, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (tag) return tag;
  } catch { /* not at a tag */ }
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      cwd: dir, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (sha) return sha;
  } catch { /* fall through */ }
  return 'unknown';
}

/** Tag-or-short-SHA for a detached HEAD. The SHA is supplied by the
 *  caller (parsed from `git worktree list --porcelain`'s `HEAD` line) so
 *  we only need one extra exec per detached worktree. */
function describeDetachedHead(worktreePath: string, headSha: string): string {
  try {
    const tag = execSync('git describe --tags --exact-match HEAD', {
      cwd: worktreePath, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (tag) return tag;
  } catch { /* not at a tag */ }
  return headSha ? headSha.slice(0, 7) : 'unknown';
}

/** Absolute path of the repo's shared `.git` directory. Sibling worktrees
 *  of the same repo always resolve to the same value — we use it as the
 *  dedup key so the scanner doesn't double-register a repo when both its
 *  main and a linked worktree sit in the scan root. */
function getGitCommonDir(dir: string): string {
  try {
    const out = execSync('git rev-parse --git-common-dir', {
      cwd: dir, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return resolve(dir, out);
  } catch {
    return dir;
  }
}

/** Discover all worktrees of the repo that `anyWorktreePath` belongs to.
 *  Index 0 is the main worktree (`type:'repo'`), the rest are linked
 *  worktrees (`type:'worktree'`).
 *
 *  All entries share the main worktree's basename as their `name` — that
 *  way the display is stable regardless of which sibling worktree the
 *  scanner happens to discover first via readdir, and the linked
 *  worktree's directory basename (often a random checkout name) doesn't
 *  leak into the UI. Renderers distinguish entries via the `branch` field
 *  and the `type:'worktree'` flag. */
function scanRepoFromAnyWorktree(anyWorktreePath: string): ProjectInfo[] {
  const fallback: ProjectInfo[] = [{
    name: basename(anyWorktreePath),
    path: anyWorktreePath,
    type: 'repo',
    branch: getGitRef(anyWorktreePath),
  }];

  let output: string;
  try {
    output = execSync('git worktree list --porcelain', {
      cwd: anyWorktreePath, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return fallback;
  }

  const entries: { path: string; branch: string }[] = [];
  let currentPath = '';
  let currentHead = '';
  let currentBranch = '';
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      currentHead = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      currentBranch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line === '') {
      if (currentPath) {
        // Branch attached → use it. Otherwise (detached / bare) fall back
        // to tag → short SHA, mirroring zsh git prompts.
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

  const main = entries[0]!;
  const repoName = basename(main.path);
  const result: ProjectInfo[] = [
    { name: repoName, path: main.path, type: 'repo', branch: main.branch },
  ];
  for (const wt of entries.slice(1)) {
    result.push({
      name: repoName,
      path: wt.path,
      type: 'worktree',
      branch: wt.branch,
    });
  }
  return result;
}

/**
 * Scan a directory for git repositories and their worktrees.
 * Returns a flat list of all projects found.
 */
export function scanProjects(baseDir: string, maxDepth: number = 3): ProjectInfo[] {
  const projects: ProjectInfo[] = [];
  const seenRepos = new Set<string>();   // by git-common-dir, dedups sibling worktrees on disk
  const seenPaths = new Set<string>();   // by absolute path

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    // Check if this directory is a git repo. The marker must be valid —
    // an empty `.git/` (no HEAD inside) is rejected so the scanner keeps
    // recursing into the directory and finds the real repos below.
    if (entries.includes('.git') && isValidGitMarker(dir)) {
      const commonDir = getGitCommonDir(dir);
      if (seenRepos.has(commonDir)) return;
      seenRepos.add(commonDir);

      for (const p of scanRepoFromAnyWorktree(dir)) {
        if (!seenPaths.has(p.path)) {
          seenPaths.add(p.path);
          projects.push(p);
        }
      }
      return; // Don't recurse into git repos
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'vendor' || entry === 'dist') continue;
      const fullPath = join(dir, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          walk(fullPath, depth + 1);
        }
      } catch {
        // Permission denied or broken symlink
      }
    }
  }

  walk(baseDir, 0);

  // Sort: repos first, then worktrees, alphabetically within each group
  projects.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'repo' ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.branch.localeCompare(b.branch);
  });

  logger.info(`Scanned ${baseDir}: found ${projects.length} project(s)`);
  return projects;
}

/**
 * Scan multiple directories for git repositories, merge and deduplicate results.
 */
export function scanMultipleProjects(baseDirs: string[], maxDepth: number = 3): ProjectInfo[] {
  const seen = new Set<string>();
  const merged: ProjectInfo[] = [];

  for (const dir of baseDirs) {
    for (const project of scanProjects(dir, maxDepth)) {
      if (!seen.has(project.path)) {
        seen.add(project.path);
        merged.push(project);
      }
    }
  }

  // Sort: repos first, then worktrees, alphabetically within each group
  merged.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'repo' ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.branch.localeCompare(b.branch);
  });

  return merged;
}
