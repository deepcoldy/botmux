import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P2-1: the host-selected console entry must enter the snapshot at BOTH
 * production generation points. The daemon-side point is
 * getDaemonReplyCardRenderSnapshot; the CLI-side local fallback lives behind a
 * subprocess fixture (cli-send-reply-card.test.ts). buildReplyConsoleUrl's own
 * remote/bound selection is covered in dashboard-url.test.ts — here we only
 * pin the wiring, so removing its line from the snapshot builder must bite.
 */
vi.mock('../src/core/dashboard-url.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/dashboard-url.js')>(),
  buildReplyConsoleUrl: vi.fn(() => undefined),
}));

import { getDaemonReplyCardRenderSnapshot } from '../src/core/worker-pool.js';
import { buildReplyConsoleUrl } from '../src/core/dashboard-url.js';
import type { DaemonSession } from '../src/core/types.js';

const consoleEntry = 'https://m-mtest.botmux.example/';

function fakeSession(): DaemonSession {
  return {
    larkAppId: 'cli_snapshot_test',
    session: {},
    workerGeneration: 1,
    replyExecutionStarts: new Map(),
    turnReceivedAtMs: new Map(),
  } as unknown as DaemonSession;
}

describe('daemon reply-render snapshot console entry', () => {
  beforeEach(() => {
    vi.mocked(buildReplyConsoleUrl).mockReset();
  });

  it('includes consoleUrl when remote access is on and the host is platform-bound', () => {
    vi.mocked(buildReplyConsoleUrl).mockReturnValue(consoleEntry);
    const snapshot = getDaemonReplyCardRenderSnapshot(fakeSession(), {});
    expect(snapshot.consoleUrl).toBe(consoleEntry);
    expect(snapshot.usage).toEqual({ context: null, tokens: null });
  });

  it('omits the key entirely when the host selects no console entry (remote off or unbound)', () => {
    vi.mocked(buildReplyConsoleUrl).mockReturnValue(undefined);
    const snapshot = getDaemonReplyCardRenderSnapshot(fakeSession(), {});
    expect(snapshot).not.toHaveProperty('consoleUrl');
  });
});
