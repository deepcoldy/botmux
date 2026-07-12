import { describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionTokenUsage: vi.fn(() => null),
}));

import { composeRowFromActive, composeRowFromClosed } from '../src/core/dashboard-rows.js';

describe('dashboard resource row fields', () => {
  it('exposes active worker and adopted CLI pids', () => {
    const ds = {
      session: {
        sessionId: 's1',
        larkAppId: 'app',
        cliId: 'codex',
        status: 'active',
        createdAt: '2026-07-09T00:00:00.000Z',
        lastMessageAt: '2026-07-09T00:00:02.000Z',
        chatId: 'oc_1',
        rootMessageId: 'om_1',
        title: 'topic',
      },
      larkAppId: 'app',
      chatId: 'oc_1',
      chatType: 'group',
      scope: 'thread',
      worker: { pid: 1234 },
      workerPort: null,
      workerToken: null,
      spawnedAt: 1,
      lastMessageAt: 2,
      cliVersion: 'x',
      hasHistory: false,
      agentAttention: { kind: 'blocked', reason: 'need input', at: 3 },
      adoptedFrom: { originalCliPid: 4321, cwd: '/repo' },
    } as unknown as DaemonSession;

    const row = composeRowFromActive(ds);

    expect(row.spawnedAt).toBe(Date.parse('2026-07-09T00:00:00.000Z'));
    expect(row.lastMessageAt).toBe(Date.parse('2026-07-09T00:00:02.000Z'));
    expect(row.agentAttention).toEqual({ kind: 'blocked', reason: 'need input', at: 3 });
    expect(row.workerPid).toBe(1234);
    expect(row.adoptCliPid).toBe(4321);
  });

  it('does not expose a stale persisted session pid when no live worker exists', () => {
    const ds = {
      session: {
        sessionId: 's1',
        larkAppId: 'app',
        cliId: 'codex',
        status: 'active',
        createdAt: '2026-07-09T00:00:00.000Z',
        chatId: 'oc_1',
        rootMessageId: 'om_1',
        pid: 9876,
      },
      larkAppId: 'app',
      chatId: 'oc_1',
      chatType: 'group',
      scope: 'thread',
      workerPort: null,
      workerToken: null,
      spawnedAt: 1,
      lastMessageAt: 2,
    } as unknown as DaemonSession;

    const row = composeRowFromActive(ds);

    expect(row).not.toHaveProperty('workerPid');
  });

  it('does not add resource pid fields to closed rows', () => {
    const row = composeRowFromClosed({
      sessionId: 's1',
      larkAppId: 'app',
      cliId: 'codex',
      status: 'closed',
      createdAt: '2026-07-09T00:00:00.000Z',
      closedAt: '2026-07-09T00:01:00.000Z',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      title: 'topic',
      adoptedFrom: { originalCliPid: 4321, cwd: '/repo' },
    });

    expect(row).not.toHaveProperty('workerPid');
    expect(row).not.toHaveProperty('adoptCliPid');
  });
});
