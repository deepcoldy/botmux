/**
 * Auto-recovery on daemon restart.
 *
 * On restart every surviving persistent-backend session is eagerly re-forked to
 * re-attach its pane, so the session actually comes back instead of sitting dead
 * until its next message (and a pane whose CLI died gets healed, keeping the
 * transcript fallback working). The old `BOTMUX_QUIET_RESTART` gate that
 * suppressed this is gone — card silence is now handled by `suppressRecoveryCard`
 * on restored sessions, not by skipping recovery.
 *
 * `staggeredRecoveryFork` spaces the re-forks out (batch + delay) so a box with
 * dozens of surviving sessions doesn't spike on restart, and skips any session
 * whose worker a real message already woke (no clobbering a live turn).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { workingDir: '~' } }),
  getAllBots: () => [],
}));

vi.mock('../src/config.js', () => ({
  config: {
    daemon: { workingDir: '~', workingDirs: ['~'], recoveryForkBatchSize: 5, recoveryForkDelayMs: 0 },
    session: { dataDir: '/tmp/botmux-test' },
  },
}));

import { shouldAutoForkOnRestore, staggeredRecoveryFork } from '../src/core/session-manager.js';
import type { DaemonSession } from '../src/core/types.js';

describe('shouldAutoForkOnRestore', () => {
  it('eagerly re-forks every persistent backend (tmux/herdr/zellij/zmx)', () => {
    expect(shouldAutoForkOnRestore('tmux')).toBe(true);
    expect(shouldAutoForkOnRestore('herdr')).toBe(true);
    expect(shouldAutoForkOnRestore('zellij')).toBe(true);
    expect(shouldAutoForkOnRestore('zmx')).toBe(true);
  });

  it('never eagerly forks the pty backend — it has no pane to re-attach', () => {
    expect(shouldAutoForkOnRestore('pty')).toBe(false);
  });
});

describe('staggeredRecoveryFork', () => {
  const ds = (id: string, worker: unknown = null) =>
    ({ worker, session: { sessionId: id, status: 'active' } } as unknown as DaemonSession);

  it('re-forks every queued session', async () => {
    const forked: string[] = [];
    await staggeredRecoveryFork(
      [ds('a'), ds('b'), ds('c')],
      (d) => forked.push(d.session.sessionId),
      5,
      0,
    );
    expect(forked).toEqual(['a', 'b', 'c']);
  });

  it('skips sessions whose worker a real message already woke', async () => {
    const forked: string[] = [];
    await staggeredRecoveryFork(
      [ds('a'), ds('live', { pid: 1 }), ds('c')],
      (d) => forked.push(d.session.sessionId),
      5,
      0,
    );
    expect(forked).toEqual(['a', 'c']); // 'live' already has a worker — not clobbered
  });

  it('isolates a synchronous recovery fork failure and continues with later owners', async () => {
    const forked: string[] = [];
    await expect(staggeredRecoveryFork(
      [ds('broken'), ds('healthy')],
      current => {
        if (current.session.sessionId === 'broken') throw new Error('init IPC rejected');
        forked.push(current.session.sessionId);
      },
      5,
      0,
    )).resolves.toBe(1);
    expect(forked).toEqual(['healthy']);
  });

  it('staggers in batches (delay only kicks in between batches)', async () => {
    const sessions = Array.from({ length: 5 }, (_, i) => ds(`s${i}`));
    const forked: string[] = [];
    const start = Date.now();
    await staggeredRecoveryFork(sessions, (d) => forked.push(d.session.sessionId), 2, 20);
    // 5 sessions / batch 2 ⇒ pauses after #2 and #4 ⇒ 2 delays of 20ms.
    expect(forked).toHaveLength(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });

  it('rechecks exact ownership after a batch delay and never forks a replaced session', async () => {
    const a = ds('a');
    const b = ds('b');
    const owned = new Set([a, b]);
    const forked: string[] = [];
    setTimeout(() => {
      owned.delete(b);
      b.session.status = 'closed';
    }, 5);

    await staggeredRecoveryFork(
      [a, b],
      current => forked.push(current.session.sessionId),
      1,
      20,
      current => owned.has(current),
    );

    expect(forked).toEqual(['a']);
  });

  it('caps total recovery forks at maxForks so a box with hundreds of sessions does not spawn hundreds of workers', async () => {
    const sessions = Array.from({ length: 20 }, (_, i) => ds(`s${i}`));
    const forked: string[] = [];
    await staggeredRecoveryFork(
      sessions,
      (d) => forked.push(d.session.sessionId),
      5,
      0,
      undefined,
      3, // maxForks
    );
    expect(forked).toHaveLength(3);
    expect(forked).toEqual(['s0', 's1', 's2']);
  });

  it('does not count sessions that already have a live worker toward the maxForks cap', async () => {
    const sessions = [
      ds('a'),
      ds('live', { pid: 1 }), // already has a worker — skipped, not counted
      ds('b'),
      ds('c'),
      ds('d'),
    ];
    const forked: string[] = [];
    await staggeredRecoveryFork(
      sessions,
      (d) => forked.push(d.session.sessionId),
      5,
      0,
      undefined,
      3, // maxForks
    );
    // 'live' is skipped (has worker); a/b/c forked (3 = cap); d stays worker-less
    expect(forked).toEqual(['a', 'b', 'c']);
  });

  it('defaults to unlimited forks when maxForks is not passed', async () => {
    const sessions = Array.from({ length: 10 }, (_, i) => ds(`s${i}`));
    const forked: string[] = [];
    await staggeredRecoveryFork(
      sessions,
      (d) => forked.push(d.session.sessionId),
      5,
      0,
    );
    expect(forked).toHaveLength(10);
  });

  it('does not count refused forks (forkWorker returned false) against the maxForks cap', async () => {
    // A quarantined tail-only owner whose promotion still fails makes
    // forkWorker return false — no worker was spawned, so no budget slot was
    // used. Such candidates must not starve later healthy sessions.
    const sessions = [ds('quarantined'), ds('a'), ds('b'), ds('c')];
    const forked: string[] = [];
    await staggeredRecoveryFork(
      sessions,
      (d) => {
        if (d.session.sessionId === 'quarantined') return false; // refused: no worker
        forked.push(d.session.sessionId);
        return true;
      },
      5,
      0,
      undefined,
      3, // maxForks
    );
    // The refused fork consumed no budget: a/b/c all forked (3 = cap).
    expect(forked).toEqual(['a', 'b', 'c']);
  });
});
