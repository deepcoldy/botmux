import { execSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { logger } from '../utils/logger.js';

export interface ProjectInfo {
  name: string;       // display name
  path: string;       // absolute path
  type: 'repo' | 'worktree';
  branch: string;     // current branch name
}

function getGitBranch(dir: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, timeout: 5000, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getWorktrees(repoPath: string): ProjectInfo[] {
  try {
    const output = execSync('git worktree list --porcelain', { cwd: repoPath, timeout: 5000, encoding: 'utf-8' });
    const worktrees: ProjectInfo[] = [];
    let currentPath = '';
    let currentBranch = '';

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        currentBranch = line.slice('branch '.length).replace('refs/heads/', '');
      } else if (line === '') {
        // End of a worktree entry — skip the main worktree (same as repoPath)
        if (currentPath && currentPath !== repoPath) {
          worktrees.push({
            name: `${basename(repoPath)}/${basename(currentPath)}`,
            path: currentPath,
            type: 'worktree',
            branch: currentBranch || 'unknown',
          });
        }
        currentPath = '';
        currentBranch = '';
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Scan a directory for git repositories and their worktrees.
 * Returns a flat list of all projects found.
 */
export function scanProjects(baseDir: string, maxDepth: number = 3): ProjectInfo[] {
  const projects: ProjectInfo[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    // Check if this directory is a git repo
    if (entries.includes('.git')) {
      const realPath = dir;
      if (!seen.has(realPath)) {
        seen.add(realPath);
        projects.push({
          name: basename(realPath),
          path: realPath,
          type: 'repo',
          branch: getGitBranch(realPath),
        });

        // Also scan for worktrees
        for (const wt of getWorktrees(realPath)) {
          if (!seen.has(wt.path)) {
            seen.add(wt.path);
            projects.push(wt);
          }
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
    return a.name.localeCompare(b.name);
  });

  logger.info(`Scanned ${baseDir}: found ${projects.length} project(s)`);
  return projects;
}
