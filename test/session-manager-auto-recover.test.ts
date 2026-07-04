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
  it('eagerly re-forks every persistent backend (tmux/herdr/zellij)', () => {
    expect(shouldAutoForkOnRestore('tmux')).toBe(true);
    expect(shouldAutoForkOnRestore('herdr')).toBe(true);
    expect(shouldAutoForkOnRestore('zellij')).toBe(true);
  });

  it('never eagerly forks the pty backend — it has no pane to re-attach', () => {
    expect(shouldAutoForkOnRestore('pty')).toBe(false);
  });
});

describe('staggeredRecoveryFork', () => {
  const ds = (id: string, worker: unknown = null) =>
    ({ worker, session: { sessionId: id } } as unknown as DaemonSession);

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

  it('staggers in batches (delay only kicks in between batches)', async () => {
    const sessions = Array.from({ length: 5 }, (_, i) => ds(`s${i}`));
    const forked: string[] = [];
    const start = Date.now();
    await staggeredRecoveryFork(sessions, (d) => forked.push(d.session.sessionId), 2, 20);
    // 5 sessions / batch 2 ⇒ pauses after #2 and #4 ⇒ 2 delays of 20ms.
    expect(forked).toHaveLength(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });
});
