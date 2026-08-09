import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scanMultipleProjectsAsync } from '../src/services/project-scanner-async.js';
import { scanMultipleProjects } from '../src/services/project-scanner.js';

let tempRoot: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'project-scanner-async-test-'));
  const repoPath = join(tempRoot, 'main-repo');
  const worktreePath = join(tempRoot, 'linked-worktree');
  mkdirSync(repoPath);
  git(repoPath, 'init', '-b', 'main');
  writeFileSync(join(repoPath, 'README.md'), '# scanner fixture\n');
  git(repoPath, 'add', 'README.md');
  git(
    repoPath,
    '-c', 'user.name=botmux-test',
    '-c', 'user.email=botmux-test@example.com',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null',
    'commit', '-m', 'test fixture',
  );
  git(repoPath, 'worktree', 'add', '-b', 'feature/linked', worktreePath);
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('scanMultipleProjectsAsync', () => {
  it('matches the synchronous scanner for a real repo and linked worktree', async () => {
    const expected = scanMultipleProjects([tempRoot]);

    const actual = await scanMultipleProjectsAsync([tempRoot]);

    expect(expected.some(project => project.type === 'worktree')).toBe(true);
    expect(actual).toEqual(expected);
  });

  it('preserves sync filtering and deduplication when worktrees are excluded', async () => {
    const options = { includeWorktrees: false };
    const expected = scanMultipleProjects([tempRoot, tempRoot], 3, options);

    const actual = await scanMultipleProjectsAsync([tempRoot, tempRoot], 3, options);

    expect(actual.every(project => project.type === 'repo')).toBe(true);
    expect(actual).toEqual(expected);
  });

  it('keeps the event loop responsive while awaiting the scan', async () => {
    const expected = scanMultipleProjects([tempRoot]);
    let timerRan = false;
    const pending = scanMultipleProjectsAsync([tempRoot]);
    setTimeout(() => {
      timerRan = true;
    }, 0);

    const actual = await pending;

    expect(timerRan).toBe(true);
    expect(actual).toEqual(expected);
  });

  it('times out a wedged scan child and lets the serial queue drain past it', async () => {
    // A child that loads then wedges on a blocking call never emits
    // message/error/close, so without a timeout the scan Promise — and the
    // global serial scanQueue behind it — would hang forever. Point the scanner
    // at a deliberately-hanging child with a tiny timeout and assert it rejects,
    // then that a subsequent scan still succeeds (queue not poisoned).
    const hangChild = join(tempRoot, 'hang-child.mjs');
    // Stays alive with an unresolved timer and never replies on IPC.
    writeFileSync(hangChild, 'setInterval(() => {}, 1 << 30);\n');
    process.env.BOTMUX_REPO_SCANNER_CHILD = hangChild;
    process.env.BOTMUX_REPO_SCAN_TIMEOUT_MS = '300';
    try {
      await expect(scanMultipleProjectsAsync([tempRoot])).rejects.toThrow(/timed out/i);
    } finally {
      delete process.env.BOTMUX_REPO_SCANNER_CHILD;
      delete process.env.BOTMUX_REPO_SCAN_TIMEOUT_MS;
    }

    // The queue must have drained: a normal scan after the wedge still works.
    const expected = scanMultipleProjects([tempRoot]);
    const actual = await scanMultipleProjectsAsync([tempRoot]);
    expect(actual).toEqual(expected);
  });

  it('settles on timeout even when the killed child never emits close', async () => {
    // Regression for the "watchdog depends on close" trap: under uninterruptible
    // I/O a killed child's 'close' can be delayed indefinitely, so settlement
    // must NOT wait for it. This child traps SIGTERM (ignores it) and keeps a
    // live timer, so 'close' will not arrive within the grace window. The scan
    // must still reject promptly (parent-owned settle), and the queue must drain.
    const stubbornChild = join(tempRoot, 'stubborn-child.mjs');
    writeFileSync(
      stubbornChild,
      "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1 << 30);\n",
    );
    process.env.BOTMUX_REPO_SCANNER_CHILD = stubbornChild;
    process.env.BOTMUX_REPO_SCAN_TIMEOUT_MS = '300';
    try {
      const started = Date.now();
      await expect(scanMultipleProjectsAsync([tempRoot])).rejects.toThrow(/timed out/i);
      // Must settle at ~timeout, well before the SIGKILL grace makes 'close'
      // eventually fire — proving settlement is parent-owned, not close-driven.
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      delete process.env.BOTMUX_REPO_SCANNER_CHILD;
      delete process.env.BOTMUX_REPO_SCAN_TIMEOUT_MS;
    }

    const expected = scanMultipleProjects([tempRoot]);
    const actual = await scanMultipleProjectsAsync([tempRoot]);
    expect(actual).toEqual(expected);
  });
});
