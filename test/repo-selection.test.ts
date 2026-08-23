/**
 * Unit tests for resolveRepoSelection — the resolver behind `/repo <path|name>`,
 * which lets a user skip the Lark repo-selection card by naming a path
 * (absolute/relative) or a first-level project name under a scan dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRepoSelection } from '../src/core/command-handler.js';
import * as projectScanner from '../src/services/project-scanner.js';
import { logger } from '../src/utils/logger.js';

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

  it('resolves a first-level project name to its repo + branch label', async () => {
    const repo = join(scanDir, 'botmux');
    mkdirSync(repo);
    gitInit(repo, 'main');

    const r = await resolveRepoSelection('botmux', [scanDir]);
    expect(r).not.toBeNull();
    expect(realpathSync(r!.path)).toBe(repo);
    expect(r!.displayName).toBe('botmux (main)');
  });

  it('does not scan unrelated roots when a candidate directory exists directly', async () => {
    const direct = join(scanDir, 'tmp');
    mkdirSync(direct);
    const scanLog = vi.spyOn(logger, 'info').mockImplementation(() => {});

    try {
      const r = await resolveRepoSelection('tmp', [scanDir]);
      expect(r).toEqual({ path: direct, displayName: 'tmp' });
      expect(scanLog).not.toHaveBeenCalledWith(expect.stringContaining('Scanned '));
    } finally {
      scanLog.mockRestore();
    }
  });

  it('resolves an absolute path to an existing git repo', async () => {
    const repo = join(scanDir, 'proj');
    mkdirSync(repo);
    gitInit(repo, 'dev');

    const r = await resolveRepoSelection(repo, [scanDir]);
    expect(r).not.toBeNull();
    expect(realpathSync(r!.path)).toBe(repo);
    expect(r!.displayName).toBe('proj (dev)');
  });

  it('resolves an explicit linked worktree path', async () => {
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
      const r = await resolveRepoSelection(worktree, [scanDir]);
      expect(r).not.toBeNull();
      expect(realpathSync(r!.path)).toBe(worktree);
      expect(r!.displayName).toBe('proj (feature/test)');
    } finally {
      execSync(`git worktree remove -f "${worktree}"`, { cwd: repo, stdio: 'pipe' });
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it('resolves a relative path against the scan dir', async () => {
    const repo = join(scanDir, 'nested', 'app');
    mkdirSync(repo, { recursive: true });
    gitInit(repo, 'main');

    const r = await resolveRepoSelection('nested/app', [scanDir]);
    expect(r).not.toBeNull();
    expect(realpathSync(r!.path)).toBe(repo);
    expect(r!.displayName).toBe('app (main)');
  });

  it('still scans for a nested project matched by basename', async () => {
    const repo = join(scanDir, 'teams', 'platform', 'deep-app');
    mkdirSync(repo, { recursive: true });
    gitInit(repo, 'main');

    const r = await resolveRepoSelection('deep-app', [scanDir]);
    expect(r).not.toBeNull();
    expect(realpathSync(r!.path)).toBe(repo);
    expect(r!.displayName).toBe('deep-app (main)');
  });

  it('runs the nested-name recursive scan off the daemon loop (async isolated), never the synchronous scanner', async () => {
    // Regression: the scan-failure recovery text suggests `/repo <name>`, which
    // hits this bare-name branch. If it ran the SYNCHRONOUS scanMultipleProjects
    // on the daemon event loop, a slow/hung mount would reintroduce the exact
    // whole-daemon hang this PR eliminates. Assert the sync scanner is never
    // called; the resolver must go through the isolated async child scanner.
    const repo = join(scanDir, 'teams', 'platform', 'deep-app');
    mkdirSync(repo, { recursive: true });
    gitInit(repo, 'main');
    const syncScan = vi.spyOn(projectScanner, 'scanMultipleProjects');

    try {
      const r = await resolveRepoSelection('deep-app', [scanDir]);
      expect(r).not.toBeNull();
      expect(realpathSync(r!.path)).toBe(repo);
      expect(syncScan).not.toHaveBeenCalled();
    } finally {
      syncScan.mockRestore();
    }
  });

  it('runs the direct-candidate stat + git describe off the daemon loop too (fully child-isolated)', async () => {
    // The direct-candidate fast-path also does synchronous fs/git — statSync +
    // describeProjectDir (which shells out to `git describe --tags`, a 2-6s
    // hotspot on huge-tag repos). On a hung mount even a single statSync locks
    // the event loop before any watchdog child starts. Assert NONE of the
    // synchronous scanner / describe runs in the parent for a direct hit; the
    // resolver delegates the whole resolution to the isolated child.
    const repo = join(scanDir, 'payments');
    mkdirSync(repo);
    gitInit(repo, 'main');
    const syncScan = vi.spyOn(projectScanner, 'scanMultipleProjects');
    const syncDescribe = vi.spyOn(projectScanner, 'describeProjectDir');

    try {
      const r = await resolveRepoSelection('payments', [scanDir]);
      expect(r).not.toBeNull();
      expect(realpathSync(r!.path)).toBe(repo);
      expect(r!.displayName).toBe('payments (main)');
      expect(syncScan).not.toHaveBeenCalled();
      expect(syncDescribe).not.toHaveBeenCalled();
    } finally {
      syncScan.mockRestore();
      syncDescribe.mockRestore();
    }
  });

  it('falls back to a plain (non-git) directory with a basename label', async () => {
    const plain = join(scanDir, 'plaindir');
    mkdirSync(plain);

    const r = await resolveRepoSelection('plaindir', [scanDir]);
    expect(r).not.toBeNull();
    expect(realpathSync(r!.path)).toBe(plain);
    expect(r!.displayName).toBe('plaindir'); // no branch — not a repo
  });

  it('returns null for a name/path that does not exist', async () => {
    expect(await resolveRepoSelection('does-not-exist', [scanDir])).toBeNull();
    expect(await resolveRepoSelection('/no/such/abs/path', [scanDir])).toBeNull();
  });

  it('prefers an absolute path over a same-named project under the scan dir', async () => {
    const inScan = join(scanDir, 'dup');
    mkdirSync(inScan);
    gitInit(inScan, 'main');

    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-repo-other-')));
    const abs = join(elsewhere, 'dup');
    mkdirSync(abs);
    gitInit(abs, 'feature');

    try {
      const r = await resolveRepoSelection(abs, [scanDir]);
      expect(r).not.toBeNull();
      expect(realpathSync(r!.path)).toBe(abs);
      expect(r!.displayName).toBe('dup (feature)');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
