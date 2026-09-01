/**
 * Auto-recovery on daemon restart.
 *
 * On restart surviving persistent-backend sessions are kept lazy by default:
 * restoring thousands of active rows must not starve message listeners by
 * eagerly re-forking every worker. Operators can explicitly opt in to eager
 * re-attach when terminal readiness is more important than startup latency.
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
    daemon: {
      workingDir: '~',
      workingDirs: ['~'],
      recoveryForkBatchSize: 5,
      recoveryForkDelayMs: 0,
      recoveryForkEnabled: false,
    },
    session: { dataDir: '/tmp/botmux-test' },
  },
}));

import { shouldAutoForkOnRestore, staggeredRecoveryFork, scheduleStaggeredRecoveryFork } from '../src/core/session-manager.js';
import type { DaemonSession } from '../src/core/types.js';

describe('shouldAutoForkOnRestore', () => {
  it('keeps persistent backends lazy by default so startup does not starve listeners', () => {
    expect(shouldAutoForkOnRestore('tmux')).toBe(false);
    expect(shouldAutoForkOnRestore('herdr')).toBe(false);
    expect(shouldAutoForkOnRestore('zellij')).toBe(false);
    expect(shouldAutoForkOnRestore('zmx')).toBe(false);
  });

  it('can explicitly eager re-attach persistent backends', () => {
    expect(shouldAutoForkOnRestore('tmux', true)).toBe(true);
    expect(shouldAutoForkOnRestore('herdr', true)).toBe(true);
    expect(shouldAutoForkOnRestore('zellij', true)).toBe(true);
    expect(shouldAutoForkOnRestore('zmx', true)).toBe(true);
  });

  it('never eagerly forks the pty backend — it has no pane to re-attach', () => {
    expect(shouldAutoForkOnRestore('pty')).toBe(false);
    expect(shouldAutoForkOnRestore('pty', true)).toBe(false);
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
    )).resolves.toBeUndefined();
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

  it('can be scheduled without blocking restore on delayed batches', async () => {
    vi.useFakeTimers();
    try {
      const sessions = Array.from({ length: 5 }, (_, i) => ds(`s${i}`));
      const forked: string[] = [];

      scheduleStaggeredRecoveryFork(sessions, (d) => forked.push(d.session.sessionId), 2, 20);

      expect(forked).toEqual(['s0', 's1']);
      await vi.advanceTimersByTimeAsync(19);
      expect(forked).toEqual(['s0', 's1']);
      await vi.advanceTimersByTimeAsync(1);
      expect(forked).toEqual(['s0', 's1', 's2', 's3']);
      await vi.advanceTimersByTimeAsync(20);
      expect(forked).toEqual(['s0', 's1', 's2', 's3', 's4']);
    } finally {
      vi.useRealTimers();
    }
  });
});
