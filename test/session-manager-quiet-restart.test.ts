/**
 * Quiet-restart gate for daemon restore.
 *
 * On restart the tmux backend eagerly re-forks every active session to
 * re-attach its surviving tmux pane — which re-renders (or re-posts) the
 * session's streaming card in the Lark thread. For local dev, repeated
 * restarts spam those cards for unfinished sessions. `BOTMUX_QUIET_RESTART=1`
 * suppresses the eager re-fork: sessions are still registered in memory and
 * resume lazily (re-attaching the surviving tmux) on the next real message,
 * exactly like the PTY backend already does. This pins that gate decision.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { workingDir: '~' } }),
  getAllBots: () => [],
}));

vi.mock('../src/config.js', () => ({
  config: {
    daemon: { workingDir: '~', workingDirs: ['~'] },
    session: { dataDir: '/tmp/botmux-test' },
  },
}));

import { shouldAutoForkOnRestore } from '../src/core/session-manager.js';

describe('shouldAutoForkOnRestore', () => {
  it('auto-forks on the tmux backend when quiet-restart is off (production default)', () => {
    expect(shouldAutoForkOnRestore('tmux', false)).toBe(true);
  });

  it('suppresses the eager re-fork on tmux when quiet-restart is on (dev restore stays silent)', () => {
    expect(shouldAutoForkOnRestore('tmux', true)).toBe(false);
  });

  it('never eagerly forks on the pty backend — it is already lazy', () => {
    expect(shouldAutoForkOnRestore('pty', false)).toBe(false);
    expect(shouldAutoForkOnRestore('pty', true)).toBe(false);
  });
});
