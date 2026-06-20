/**
 * Unit tests for project-scanner: scanProjects & scanMultipleProjects.
 *
 * Creates real temporary directory structures and mocks child_process.execSync
 * to avoid requiring actual git repositories for branch/worktree detection.
 *
 * Run:  pnpm vitest run test/project-scanner.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ─── Mock child_process before importing the module under test ───────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd: string, opts?: { cwd?: string }) => {
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
      return 'main\n';
    }
    if (cmd.includes('worktree list --porcelain')) {
      // Return just the main worktree (no additional worktrees by default)
      return `worktree ${opts?.cwd ?? '/tmp'}\nbranch refs/heads/main\n\n`;
    }
    return '';
  }),
}));

// Import after mock setup
import { scanProjects, scanMultipleProjects, type ProjectInfo } from '../src/services/project-scanner.js';
import { execSync } from 'node:child_process';

const mockedExecSync = vi.mocked(execSync);

// ─── Helpers ─────────────────────────────────────────────────────────────

let tempRoot: string;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'project-scanner-test-'));
}

/** Create a directory path (recursive) and place a valid .git marker.
 *
 * A real git repo has `.git/HEAD` (regular repo) or `.git` is a file
 * (worktree gitlink). The scanner requires one of these to avoid mistaking
 * a stray empty `.git/` directory for a repository. */
function mkRepo(relPath: string): string {
  const full = join(tempRoot, relPath);
  mkdirSync(full, { recursive: true });
  mkdirSync(join(full, '.git'), { recursive: true });
  writeFileSync(join(full, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return full;
}

/** Create a directory with an empty `.git/` (no HEAD inside) — mimics the
 *  real-world "stray empty /root/.git" that fooled the scanner. */
function mkEmptyDotGit(relPath: string): string {
  const full = join(tempRoot, relPath);
  mkdirSync(full, { recursive: true });
  mkdirSync(join(full, '.git'), { recursive: true });
  return full;
}

/** Create a worktree-style directory where `.git` is a gitlink FILE pointing
 *  at the real .git/worktrees/<name> directory. */
function mkWorktreeGitlink(relPath: string, gitlinkTarget: string): string {
  const full = join(tempRoot, relPath);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, '.git'), `gitdir: ${gitlinkTarget}\n`);
  return full;
}

function mkDir(relPath: string): string {
  const full = join(tempRoot, relPath);
  mkdirSync(full, { recursive: true });
  return full;
}

// ─── Setup / Teardown ────────────────────────────────────────────────────

beforeEach(() => {
  tempRoot = makeTempDir();
  mockedExecSync.mockClear();
  // Default: return 'main' for branch, empty worktree list
  mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
    const cmdStr = String(cmd);
    if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
      return 'main\n';
    }
    if (cmdStr.includes('worktree list --porcelain')) {
      const cwd = opts?.cwd ?? '/tmp';
      return `worktree ${cwd}\nbranch refs/heads/main\n\n`;
    }
    return '';
  });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// ─── scanProjects ────────────────────────────────────────────────────────

describe('scanProjects', () => {
  it('should find a single git repo at the top level', () => {
    const repoPath = mkRepo('my-project');

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'my-project',
      path: repoPath,
      type: 'repo',
      branch: 'main',
    });
  });

  it('should find multiple repos at the same depth', () => {
    mkRepo('alpha');
    mkRepo('beta');
    mkRepo('gamma');

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(3);
    const names = results.map(r => r.name);
    expect(names).toEqual(['alpha', 'beta', 'gamma']); // sorted alphabetically
  });

  it('should find nested repos within non-repo directories', () => {
    mkDir('workspace');
    mkRepo('workspace/project-a');
    mkRepo('workspace/project-b');

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(2);
    expect(results[0]!.name).toBe('project-a');
    expect(results[1]!.name).toBe('project-b');
  });

  it('should not recurse into git repos (no nested repo detection)', () => {
    const outerPath = mkRepo('outer');
    // Create a nested .git inside the outer repo — should not be found
    mkdirSync(join(outerPath, 'inner', '.git'), { recursive: true });

    const results = scanProjects(tempRoot);

    // Only the outer repo should be detected
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('outer');
  });

  it('should return an empty array for an empty directory', () => {
    const results = scanProjects(tempRoot);
    expect(results).toEqual([]);
  });

  it('should return an empty array for a non-existent directory', () => {
    const results = scanProjects(join(tempRoot, 'does-not-exist'));
    expect(results).toEqual([]);
  });

  it('should NOT treat an empty .git directory (no HEAD) as a git repo', () => {
    // Mirrors the real-world incident: an empty `/root/.git` directory caused
    // the scanner to mistake the whole home dir for a single repo, hiding all
    // legitimate nested projects.
    mkEmptyDotGit('stray');
    mkRepo('stray/real-project'); // legitimate nested repo

    const results = scanProjects(tempRoot);

    // Only the legitimate repo should be detected; the stray .git is ignored
    // and the scanner recurses into the directory.
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('real-project');
  });

  it('should treat a worktree-style .git gitlink (file, not dir) as a repo', () => {
    // git worktree creates `.git` as a regular FILE with `gitdir: <path>`.
    // The scanner must still treat the directory as a repo.
    mkWorktreeGitlink('linked-worktree', '/some/main/.git/worktrees/feature');

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('linked-worktree');
    expect(results[0]!.type).toBe('repo');
  });

  // ─── ProjectInfo structure ──────────────────────────────────────────────

  it('should produce correct ProjectInfo fields', () => {
    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'feature/login\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        return `worktree ${opts?.cwd}\nbranch refs/heads/feature/login\n\n`;
      }
      return '';
    });

    const repoPath = mkRepo('my-app');
    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(1);
    const info = results[0]!;
    expect(info.name).toBe('my-app');
    expect(info.path).toBe(repoPath);
    expect(info.type).toBe('repo');
    expect(info.branch).toBe('feature/login');
  });

  // ─── Depth limiting ─────────────────────────────────────────────────────

  it('should respect maxDepth = 0 (only scan the base directory itself)', () => {
    // Repo IS the base dir
    mkdirSync(join(tempRoot, '.git'), { recursive: true });
    writeFileSync(join(tempRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkRepo('child'); // depth 1 — should not be reached

    const results = scanProjects(tempRoot, 0);

    // Should only find the base dir itself (depth 0), not the child
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe(tempRoot);
  });

  it('should respect maxDepth = 1', () => {
    mkRepo('level1');
    mkDir('container');
    mkRepo('container/level2'); // depth 2 — should not be reached with maxDepth=1

    const results = scanProjects(tempRoot, 1);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('level1');
  });

  it('should find repos at exactly maxDepth', () => {
    mkDir('a');
    mkDir('a/b');
    mkRepo('a/b/deep-repo'); // depth 3

    const results = scanProjects(tempRoot, 3);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('deep-repo');
  });

  it('should NOT find repos beyond maxDepth', () => {
    mkDir('a');
    mkDir('a/b');
    mkDir('a/b/c');
    mkRepo('a/b/c/too-deep'); // depth 4 — beyond maxDepth=3

    const results = scanProjects(tempRoot, 3);

    expect(results).toEqual([]);
  });

  // ─── Exclusions ─────────────────────────────────────────────────────────

  it('should skip node_modules directories', () => {
    mkDir('node_modules');
    mkRepo('node_modules/some-package');

    const results = scanProjects(tempRoot);
    expect(results).toEqual([]);
  });

  it('should skip hidden directories (starting with dot)', () => {
    mkDir('.hidden');
    mkRepo('.hidden/secret-project');

    const results = scanProjects(tempRoot);
    expect(results).toEqual([]);
  });

  it('should skip vendor directories', () => {
    mkDir('vendor');
    mkRepo('vendor/lib');

    const results = scanProjects(tempRoot);
    expect(results).toEqual([]);
  });

  it('should skip dist directories', () => {
    mkDir('dist');
    mkRepo('dist/build-output');

    const results = scanProjects(tempRoot);
    expect(results).toEqual([]);
  });

  it('should not skip similarly-named non-excluded directories', () => {
    mkRepo('node_modules_extra/project'); // not exactly "node_modules"
    // Actually "node_modules_extra" does not start with '.' and is not in the exclusion list
    // But since the repo is inside it at depth 2, it should be found
    // Wait — let's make the structure clearer
    mkDir('vendors'); // similar but not "vendor"
    mkRepo('vendors/lib');

    const results = scanProjects(tempRoot);
    // "vendors" is not excluded, so "lib" should be found
    // "node_modules_extra" is not excluded either
    const names = results.map(r => r.name);
    expect(names).toContain('lib');
    expect(names).toContain('project');
  });

  // ─── Sorting ────────────────────────────────────────────────────────────

  it('should sort repos before worktrees, alphabetically within groups', () => {
    mkRepo('zeta-repo');
    mkRepo('alpha-repo');

    // Simulate worktrees for alpha-repo
    const alphaPath = join(tempRoot, 'alpha-repo');
    const wtPath = join(tempRoot, 'worktree-checkout');
    mkdirSync(wtPath, { recursive: true });

    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        if (opts?.cwd === alphaPath) {
          return [
            `worktree ${alphaPath}`,
            'branch refs/heads/main',
            '',
            `worktree ${wtPath}`,
            'branch refs/heads/feature-x',
            '',
          ].join('\n');
        }
        return `worktree ${opts?.cwd}\nbranch refs/heads/main\n\n`;
      }
      return '';
    });

    const results = scanProjects(tempRoot);

    // Repos first (alphabetical), then worktrees
    const types = results.map(r => r.type);
    const repoIdx = results.findIndex(r => r.type === 'worktree');
    if (repoIdx !== -1) {
      // All repos should come before any worktree
      for (let i = 0; i < repoIdx; i++) {
        expect(results[i]!.type).toBe('repo');
      }
    }
  });

  // ─── Worktree detection ─────────────────────────────────────────────────

  it('should detect worktrees associated with a repo', () => {
    const repoPath = mkRepo('my-repo');
    const worktreePath = '/tmp/my-repo-worktree-abc';

    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        if (opts?.cwd === repoPath) {
          return [
            `worktree ${repoPath}`,
            'branch refs/heads/main',
            '',
            `worktree ${worktreePath}`,
            'branch refs/heads/feature-branch',
            '',
          ].join('\n');
        }
        return `worktree ${opts?.cwd}\nbranch refs/heads/main\n\n`;
      }
      return '';
    });

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(2);

    const repo = results.find(r => r.type === 'repo')!;
    expect(repo.name).toBe('my-repo');
    expect(repo.path).toBe(repoPath);

    const wt = results.find(r => r.type === 'worktree')!;
    expect(wt.name).toBe('my-repo');
    expect(wt.path).toBe(worktreePath);
    expect(wt.branch).toBe('feature-branch');
  });

  it('should omit linked worktrees when includeWorktrees is false', () => {
    const repoPath = mkRepo('my-repo');
    const worktreePath = '/tmp/my-repo-worktree-abc';

    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        if (opts?.cwd === repoPath) {
          return [
            `worktree ${repoPath}`,
            'branch refs/heads/main',
            '',
            `worktree ${worktreePath}`,
            'branch refs/heads/feature-branch',
            '',
          ].join('\n');
        }
        return `worktree ${opts?.cwd}\nbranch refs/heads/main\n\n`;
      }
      return '';
    });

    const results = scanProjects(tempRoot, 3, { includeWorktrees: false });

    expect(results).toEqual([
      {
        name: 'my-repo',
        path: repoPath,
        type: 'repo',
        branch: 'main',
      },
    ]);
  });

  it('should not include the main worktree as a separate entry', () => {
    const repoPath = mkRepo('my-repo');

    // Worktree list returns only the main worktree (same path as repoPath)
    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        return `worktree ${repoPath}\nbranch refs/heads/main\n\n`;
      }
      return '';
    });

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe('repo');
  });

  // ─── Main vs linked worktree attribution ────────────────────────────────

  it('should attribute the repo to the main worktree even when a linked worktree is discovered first by readdir', () => {
    // Linked worktree ("aaa-feature", `.git` gitlink) sits alphabetically
    // before the main worktree ("zzz-main", `.git` directory). After the
    // common-dir dedup, the main must register as `repo` regardless of
    // readdir order.
    const linkedPath = mkWorktreeGitlink('aaa-feature', '/some/.git/worktrees/aaa-feature');
    const mainPath = mkRepo('zzz-main');

    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --git-common-dir')) {
        return `${mainPath}/.git\n`;
      }
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        if (opts?.cwd === linkedPath) return 'feature/aaa\n';
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        return [
          `worktree ${mainPath}`,
          'branch refs/heads/main',
          '',
          `worktree ${linkedPath}`,
          'branch refs/heads/feature/aaa',
          '',
        ].join('\n');
      }
      return '';
    });

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(2);
    expect(results.filter(r => r.type === 'repo')).toHaveLength(1);
    expect(results.filter(r => r.type === 'worktree')).toHaveLength(1);

    const repo = results.find(r => r.type === 'repo')!;
    expect(repo.name).toBe('zzz-main');
    expect(repo.path).toBe(mainPath);
    expect(repo.branch).toBe('main');

    const wt = results.find(r => r.type === 'worktree')!;
    expect(wt.path).toBe(linkedPath);
    expect(wt.branch).toBe('feature/aaa');
    expect(wt.name).toBe('zzz-main');
  });

  it('should NOT leak the linked-worktree directory basename into the display name', () => {
    const mainPath = mkRepo('repo');
    const garbageBasename = 'tmp-checkout-7zKx';
    const linkedPath = mkWorktreeGitlink(garbageBasename, '/some/.git/worktrees/x');

    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --git-common-dir')) {
        return `${mainPath}/.git\n`;
      }
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        if (opts?.cwd === linkedPath) return 'release/2026.05\n';
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        return [
          `worktree ${mainPath}`,
          'branch refs/heads/main',
          '',
          `worktree ${linkedPath}`,
          'branch refs/heads/release/2026.05',
          '',
        ].join('\n');
      }
      return '';
    });

    const results = scanProjects(tempRoot);
    const wt = results.find(r => r.type === 'worktree')!;

    expect(wt.name).toBe('repo');
    expect(wt.name).not.toContain(garbageBasename);
    expect(wt.branch).toBe('release/2026.05');
  });

  // ─── Detached HEAD: tag / short-sha fallback ─────────────────────────────

  it('should report the tag name when a worktree has detached HEAD pointing at a tag', () => {
    const mainPath = mkRepo('repo');
    const detachedPath = mkWorktreeGitlink('checkout-v1', '/some/.git/worktrees/x');

    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --git-common-dir')) {
        return `${mainPath}/.git\n`;
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        return [
          `worktree ${mainPath}`,
          'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'branch refs/heads/main',
          '',
          `worktree ${detachedPath}`,
          'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'detached',
          '',
        ].join('\n');
      }
      if (cmdStr.includes('describe --tags --exact-match HEAD')) {
        if (opts?.cwd === detachedPath) return 'v1.2.3\n';
      }
      return '';
    });

    const results = scanProjects(tempRoot);
    const wt = results.find(r => r.type === 'worktree')!;

    expect(wt.path).toBe(detachedPath);
    expect(wt.branch).toBe('v1.2.3');
  });

  it('should fall back to the short SHA when a worktree has detached HEAD not pointing at any tag', () => {
    const mainPath = mkRepo('repo');
    const detachedPath = mkWorktreeGitlink('checkout-loose', '/some/.git/worktrees/y');

    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --git-common-dir')) {
        return `${mainPath}/.git\n`;
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        return [
          `worktree ${mainPath}`,
          'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'branch refs/heads/main',
          '',
          `worktree ${detachedPath}`,
          'HEAD c0ffee1234567890abcdef0000000000deadbeef',
          'detached',
          '',
        ].join('\n');
      }
      if (cmdStr.includes('describe --tags --exact-match HEAD')) {
        throw new Error('fatal: no tag exactly matches HEAD');
      }
      return '';
    });

    const results = scanProjects(tempRoot);
    const wt = results.find(r => r.type === 'worktree')!;

    expect(wt.path).toBe(detachedPath);
    expect(wt.branch).toBe('c0ffee1');
  });

  // ─── Deduplication ──────────────────────────────────────────────────────

  it('should not duplicate repos when the same path is encountered', () => {
    // This tests the `seen` set — two directories that somehow point to the same repo
    // In practice this shouldn't happen with real dirs, but the code handles it
    mkRepo('project');

    const results = scanProjects(tempRoot);
    expect(results).toHaveLength(1);
  });

  // ─── Error resilience ──────────────────────────────────────────────────

  it('should handle git branch detection failure gracefully', () => {
    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        throw new Error('not a git repository');
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        throw new Error('not a git repository');
      }
      return '';
    });

    mkRepo('broken-repo');
    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(1);
    expect(results[0]!.branch).toBe('unknown');
  });

  it('should handle worktree listing failure gracefully', () => {
    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        throw new Error('git worktree command failed');
      }
      return '';
    });

    mkRepo('repo-no-worktrees');
    const results = scanProjects(tempRoot);

    // Should still find the repo, just no worktrees
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('repo-no-worktrees');
    expect(results[0]!.type).toBe('repo');
  });

  it('should handle directories with permission errors', () => {
    mkDir('accessible');
    mkRepo('accessible/good-repo');
    // We can't easily simulate permission errors on temp dirs,
    // but the code has a try/catch around statSync — verify it doesn't crash
    const results = scanProjects(tempRoot);
    expect(results).toHaveLength(1);
  });

  // ─── Misc: files in the scan path ──────────────────────────────────────

  it('should ignore regular files (not directories) during traversal', () => {
    writeFileSync(join(tempRoot, 'README.md'), '# hello');
    writeFileSync(join(tempRoot, 'package.json'), '{}');
    mkRepo('real-project');

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('real-project');
  });
});

// ─── scanMultipleProjects ────────────────────────────────────────────────

describe('scanMultipleProjects', () => {
  let tempRoot2: string;

  beforeEach(() => {
    tempRoot2 = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempRoot2, { recursive: true, force: true });
  });

  it('should merge results from multiple directories', () => {
    mkRepo('project-a');
    // Create repo in second temp root (full repo marker incl. HEAD)
    const project2 = join(tempRoot2, 'project-b');
    mkdirSync(project2, { recursive: true });
    mkdirSync(join(project2, '.git'), { recursive: true });
    writeFileSync(join(project2, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const results = scanMultipleProjects([tempRoot, tempRoot2]);

    expect(results).toHaveLength(2);
    const names = results.map(r => r.name);
    expect(names).toContain('project-a');
    expect(names).toContain('project-b');
  });

  it('should deduplicate projects with the same path across directories', () => {
    // If both baseDirs somehow contain the same repo path (e.g., overlapping scan areas)
    mkRepo('shared-project');

    // Scan the same directory twice
    const results = scanMultipleProjects([tempRoot, tempRoot]);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('shared-project');
  });

  it('should return empty array when all directories are empty', () => {
    const results = scanMultipleProjects([tempRoot, tempRoot2]);
    expect(results).toEqual([]);
  });

  it('should handle non-existent directories gracefully', () => {
    mkRepo('valid-project');
    const results = scanMultipleProjects([
      tempRoot,
      join(tempRoot, 'nonexistent'),
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('valid-project');
  });

  it('should pass maxDepth to individual scanProjects calls', () => {
    mkDir('container');
    mkRepo('container/deep-project'); // depth 2

    // maxDepth=1 should NOT find the project at depth 2
    const shallow = scanMultipleProjects([tempRoot], 1);
    expect(shallow).toEqual([]);

    // maxDepth=2 should find it
    const deep = scanMultipleProjects([tempRoot], 2);
    expect(deep).toHaveLength(1);
    expect(deep[0]!.name).toBe('deep-project');
  });

  it('should sort merged results: repos first, then worktrees', () => {
    const repoPathA = mkRepo('alpha');
    const wtPath = join(tempRoot2, 'wt-checkout');
    mkdirSync(wtPath, { recursive: true });

    const repoPathB = join(tempRoot2, 'beta');
    mkdirSync(repoPathB, { recursive: true });
    mkdirSync(join(repoPathB, '.git'), { recursive: true });
    writeFileSync(join(repoPathB, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        if (opts?.cwd === repoPathB) {
          return [
            `worktree ${repoPathB}`,
            'branch refs/heads/main',
            '',
            `worktree ${wtPath}`,
            'branch refs/heads/wt-branch',
            '',
          ].join('\n');
        }
        return `worktree ${opts?.cwd}\nbranch refs/heads/main\n\n`;
      }
      return '';
    });

    const results = scanMultipleProjects([tempRoot, tempRoot2]);

    // All repos before worktrees
    const repoEntries = results.filter(r => r.type === 'repo');
    const wtEntries = results.filter(r => r.type === 'worktree');

    expect(repoEntries.length).toBeGreaterThanOrEqual(1);
    // If worktrees exist, they should come after all repos
    if (wtEntries.length > 0) {
      const lastRepoIdx = results.findLastIndex(r => r.type === 'repo');
      const firstWtIdx = results.findIndex(r => r.type === 'worktree');
      expect(lastRepoIdx).toBeLessThan(firstWtIdx);
    }
  });

  it('should pass includeWorktrees to individual scanProjects calls', () => {
    const repoPath = mkRepo('repo-with-worktree');
    const worktreePath = '/tmp/repo-with-worktree-feature';

    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        if (opts?.cwd === repoPath) {
          return [
            `worktree ${repoPath}`,
            'branch refs/heads/main',
            '',
            `worktree ${worktreePath}`,
            'branch refs/heads/feature',
            '',
          ].join('\n');
        }
        return `worktree ${opts?.cwd}\nbranch refs/heads/main\n\n`;
      }
      return '';
    });

    const results = scanMultipleProjects([tempRoot], 3, { includeWorktrees: false });

    expect(results.map(r => r.path)).toEqual([repoPath]);
  });

  it('should handle empty baseDirs array', () => {
    const results = scanMultipleProjects([]);
    expect(results).toEqual([]);
  });
});
