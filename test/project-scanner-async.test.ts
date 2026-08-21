import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scanMultipleProjectsAsync, resolveRepoSelectionAsync } from '../src/services/project-scanner-async.js';
import { scanMultipleProjects } from '../src/services/project-scanner.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: probe existence without killing
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours
  }
}

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

  it('settles on timeout even when the killed child never emits close, and still reaps it via SIGKILL', async () => {
    // Two coupled regressions:
    //  (a) "watchdog depends on close": under uninterruptible I/O a killed
    //      child's 'close' can be delayed indefinitely, so settlement must not
    //      wait for it — the scan must reject promptly (parent-owned settle).
    //  (b) "settle cancels its own SIGKILL": a child that ignores SIGTERM (the
    //      wedge case) must still be reaped by the escalated SIGKILL. settle()
    //      must NOT clear the reap timer, or the process leaks forever.
    // This child traps SIGTERM (ignores it), writes its PID, and keeps a live
    // timer so 'close' won't arrive within the grace window.
    const pidFile = join(tempRoot, 'stubborn-child.pid');
    const stubbornChild = join(tempRoot, 'stubborn-child.mjs');
    writeFileSync(
      stubbornChild,
      "import { writeFileSync } from 'node:fs';\n"
      + `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`
      + "process.on('SIGTERM', () => {});\n"
      + 'setInterval(() => {}, 1 << 30);\n',
    );
    process.env.BOTMUX_REPO_SCANNER_CHILD = stubbornChild;
    process.env.BOTMUX_REPO_SCAN_TIMEOUT_MS = '300';
    let childPid: number | undefined;
    try {
      const started = Date.now();
      await expect(scanMultipleProjectsAsync([tempRoot])).rejects.toThrow(/timed out/i);
      // (a) Must settle at ~timeout, well before the SIGKILL grace elapses —
      // proving settlement is parent-owned, not close-driven.
      expect(Date.now() - started).toBeLessThan(1_500);

      // (b) After SIGTERM (ignored) + the 2s grace + SIGKILL, the child must be
      // dead. Poll past the grace window and assert the recorded PID is gone.
      expect(existsSync(pidFile)).toBe(true);
      childPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
      let alive = true;
      for (let i = 0; i < 40 && alive; i++) {
        await delay(100);
        alive = isProcessAlive(childPid);
      }
      expect(alive).toBe(false); // SIGKILL reaped it — no orphan leak
    } finally {
      delete process.env.BOTMUX_REPO_SCANNER_CHILD;
      delete process.env.BOTMUX_REPO_SCAN_TIMEOUT_MS;
      if (childPid && isProcessAlive(childPid)) {
        try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }

    const expected = scanMultipleProjects([tempRoot]);
    const actual = await scanMultipleProjectsAsync([tempRoot]);
    expect(actual).toEqual(expected);
  });

  it('resolves /repo without waiting behind an in-flight (slow) scan', async () => {
    // The scan-failure recovery text points users to `/repo <path>` as the
    // immediate escape hatch. If resolve were serialized behind the scan queue,
    // it would block for the ENTIRE slow scan — exactly when the user needs to
    // bypass it. A branching child: `scan` requests hang forever, `resolve`
    // requests answer immediately. With resolve unqueued, the resolve must
    // return promptly even while a scan is wedged.
    const branchChild = join(tempRoot, 'branch-child.mjs');
    writeFileSync(
      branchChild,
      "process.once('message', (req) => {\n"
      + "  if (req && req.kind === 'resolve') {\n"
      + "    process.send({ ok: true, resolved: { path: '/abs/x', displayName: 'x (main)' } }, () => process.disconnect());\n"
      + "    return;\n"
      + "  }\n"
      + "  setInterval(() => {}, 1 << 30); // scan: hang forever, never reply\n"
      + "});\n",
    );
    process.env.BOTMUX_REPO_SCANNER_CHILD = branchChild;
    process.env.BOTMUX_REPO_SCAN_TIMEOUT_MS = '30000'; // long, so the scan is genuinely in-flight
    try {
      // Kick off a scan that will hang for the whole (long) timeout.
      const scanPromise = scanMultipleProjectsAsync([tempRoot]).catch(() => 'scan-failed');
      // Concurrently resolve — must NOT wait for the wedged scan.
      const started = Date.now();
      const resolved = await resolveRepoSelectionAsync('/abs/x', [tempRoot]);
      const elapsed = Date.now() - started;

      expect(resolved).toEqual({ path: '/abs/x', displayName: 'x (main)' });
      expect(elapsed).toBeLessThan(5000); // did not block on the 30s scan
      void scanPromise; // leave the scan wedged; its child is reaped on timeout/teardown
    } finally {
      delete process.env.BOTMUX_REPO_SCANNER_CHILD;
      delete process.env.BOTMUX_REPO_SCAN_TIMEOUT_MS;
    }
  });

  it('runs concurrent /repo resolves in parallel, not serialized behind each other', async () => {
    // Two resolves from different topics must not block one another. A child
    // that sleeps ~800ms before answering a resolve: run two concurrently and
    // assert total wall-clock is far below 2× (proving parallel, not queued).
    const slowResolveChild = join(tempRoot, 'slow-resolve-child.mjs');
    writeFileSync(
      slowResolveChild,
      "process.once('message', () => {\n"
      + "  setTimeout(() => {\n"
      + "    process.send({ ok: true, resolved: { path: '/abs/y', displayName: 'y (main)' } }, () => process.disconnect());\n"
      + "  }, 800);\n"
      + "});\n",
    );
    process.env.BOTMUX_REPO_SCANNER_CHILD = slowResolveChild;
    try {
      const started = Date.now();
      const [a, b] = await Promise.all([
        resolveRepoSelectionAsync('/abs/y', ['/root/topic-a']),
        resolveRepoSelectionAsync('/abs/y', ['/root/topic-b']),
      ]);
      const elapsed = Date.now() - started;
      expect(a).toEqual({ path: '/abs/y', displayName: 'y (main)' });
      expect(b).toEqual({ path: '/abs/y', displayName: 'y (main)' });
      // Serialized would be ~1600ms; parallel ~800ms. Allow generous slack.
      expect(elapsed).toBeLessThan(1400);
    } finally {
      delete process.env.BOTMUX_REPO_SCANNER_CHILD;
    }
  });
});
