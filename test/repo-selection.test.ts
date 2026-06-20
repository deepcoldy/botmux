/**
 * Unit tests for resolveRepoSelection — the resolver behind `/repo <path|name>`,
 * which lets a user skip the Lark repo-selection card by naming a path
 * (absolute/relative) or a first-level project name under a scan dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRepoSelection } from '../src/core/command-handler.js';

function gitInit(dir: string, branch = 'main'): void {
  execSync(`git init -q -b ${branch} "${dir}"`, { stdio: 'pipe' });
  execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', {
    cwd: dir,
    stdio: 'pipe',
  });
}

describe('resolveRepoSelection', () => {
  let scanDir: string; // a workingDir scan root
  let prevCwd: string;

  beforeEach(() => {
    // realpathSync so macOS /var → /private/var symlink doesn't break equality.
    scanDir = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-repo-scan-')));
    prevCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(scanDir, { recursive: true, force: true });
  });

  it('resolves a first-level project name to its repo + branch label', () => {
    const repo = join(scanDir, 'botmux');
    mkdirSync(repo);
    gitInit(repo, 'main');

    const r = resolveRepoSelection('botmux', [scanDir]);
    expect(r).not.toBeNull();
    expect(realpathSync(r!.path)).toBe(repo);
    expect(r!.displayName).toBe('botmux (main)');
  });

  it('resolves an absolute path to an existing git repo', () => {
    const repo = join(scanDir, 'proj');
    mkdirSync(repo);
    gitInit(repo, 'dev');

    const r = resolveRepoSelection(repo, [scanDir]);
    expect(r).not.toBeNull();
    expect(realpathSync(r!.path)).toBe(repo);
    expect(r!.displayName).toBe('proj (dev)');
  });

  it('resolves an explicit linked worktree path', () => {
    const repo = join(scanDir, 'proj');
    mkdirSync(repo);
    gitInit(repo, 'main');

    const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-repo-worktree-')));
    const worktree = join(worktreeRoot, 'proj-feature');
    execSync(`git worktree add -q -b feature/test "${worktree}"`, {
      cwd: repo,
      stdio: 'pipe',
    });

    try {
      const r = resolveRepoSelection(worktree, [scanDir]);
      expect(r).not.toBeNull();
      expect(realpathSync(r!.path)).toBe(worktree);
      expect(r!.displayName).toBe('proj (feature/test)');
    } finally {
      execSync(`git worktree remove -f "${worktree}"`, { cwd: repo, stdio: 'pipe' });
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it('resolves a relative path against the scan dir', () => {
    const repo = join(scanDir, 'nested', 'app');
    mkdirSync(repo, { recursive: true });
    gitInit(repo, 'main');

    const r = resolveRepoSelection('nested/app', [scanDir]);
    expect(r).not.toBeNull();
    expect(realpathSync(r!.path)).toBe(repo);
    expect(r!.displayName).toBe('app (main)');
  });

  it('falls back to a plain (non-git) directory with a basename label', () => {
    const plain = join(scanDir, 'plaindir');
    mkdirSync(plain);

    const r = resolveRepoSelection('plaindir', [scanDir]);
    expect(r).not.toBeNull();
    expect(realpathSync(r!.path)).toBe(plain);
    expect(r!.displayName).toBe('plaindir'); // no branch — not a repo
  });

  it('returns null for a name/path that does not exist', () => {
    expect(resolveRepoSelection('does-not-exist', [scanDir])).toBeNull();
    expect(resolveRepoSelection('/no/such/abs/path', [scanDir])).toBeNull();
  });

  it('prefers an absolute path over a same-named project under the scan dir', () => {
    const inScan = join(scanDir, 'dup');
    mkdirSync(inScan);
    gitInit(inScan, 'main');

    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-repo-other-')));
    const abs = join(elsewhere, 'dup');
    mkdirSync(abs);
    gitInit(abs, 'feature');

    try {
      const r = resolveRepoSelection(abs, [scanDir]);
      expect(r).not.toBeNull();
      expect(realpathSync(r!.path)).toBe(abs);
      expect(r!.displayName).toBe('dup (feature)');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
