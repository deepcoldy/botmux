import { describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionTokenUsage: vi.fn(() => null),
}));

import {
  composeRowFromActive,
  composeRowFromClosed,
  composeRowFromPersistedActive,
} from '../src/core/dashboard-rows.js';

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

  it('publishes native topic id as threadId for active thread-scope rows', () => {
    const ds = {
      session: {
        sessionId: 's_thread',
        larkAppId: 'app',
        cliId: 'codex',
        status: 'active',
        createdAt: '2026-07-09T00:00:00.000Z',
        chatId: 'oc_thread',
        rootMessageId: 'om_thread',
        scope: 'thread',
        larkThreadId: 'omt_native_thread_active',
      },
      larkAppId: 'app',
      chatId: 'oc_thread',
      chatType: 'group',
      scope: 'thread',
      workerPort: null,
      workerToken: null,
      spawnedAt: 1,
      lastMessageAt: 2,
    } as unknown as DaemonSession;

    const row = composeRowFromActive(ds);
    expect(row.threadId).toBe('omt_native_thread_active');
    expect(row.feishuThreadLink).toBeDefined();
  });

  it('publishes native topic id as threadId for closed thread-scope rows', () => {
    const row = composeRowFromClosed({
      sessionId: 's_closed_thread',
      larkAppId: 'app',
      cliId: 'codex',
      status: 'closed',
      createdAt: '2026-07-09T00:00:00.000Z',
      closedAt: '2026-07-09T00:01:00.000Z',
      chatId: 'oc_thread',
      rootMessageId: 'om_thread',
      scope: 'thread',
      larkThreadId: 'omt_native_thread_closed',
      title: 'topic',
    } as never);
    expect(row.threadId).toBe('omt_native_thread_closed');
  });

  it('publishes native topic id as threadId for persisted-active thread-scope rows', () => {
    const row = composeRowFromPersistedActive({
      sessionId: 's_persisted_thread',
      larkAppId: 'app',
      cliId: 'codex',
      status: 'active',
      createdAt: '2026-07-09T00:00:00.000Z',
      chatId: 'oc_thread',
      rootMessageId: 'om_thread',
      scope: 'thread',
      larkThreadId: 'omt_native_thread_persisted',
      title: 'topic',
    } as never);
    expect(row.threadId).toBe('omt_native_thread_persisted');
  });

  it('does not fabricate threadId for chat-scope sessions even with larkThreadId set', () => {
    const row = composeRowFromClosed({
      sessionId: 's_chat',
      larkAppId: 'app',
      cliId: 'codex',
      status: 'closed',
      createdAt: '2026-07-09T00:00:00.000Z',
      chatId: 'oc_chat',
      rootMessageId: 'om_chat',
      scope: 'chat',
      larkThreadId: 'omt_should_be_ignored',
    } as never);
    expect(row.threadId).toBeUndefined();
  });

  it('rejects non-native topic id shapes (only omt_* is durable identity)', () => {
    const ds = {
      session: {
        sessionId: 's_bad',
        larkAppId: 'app',
        cliId: 'codex',
        status: 'active',
        createdAt: '2026-07-09T00:00:00.000Z',
        chatId: 'oc_bad',
        rootMessageId: 'om_bad',
        scope: 'thread',
        larkThreadId: 'om_not_native',
      },
      larkAppId: 'app',
      chatId: 'oc_bad',
      chatType: 'group',
      scope: 'thread',
      workerPort: null,
      workerToken: null,
      spawnedAt: 1,
      lastMessageAt: 2,
    } as unknown as DaemonSession;

    const row = composeRowFromActive(ds);
    expect(row.threadId).toBeUndefined();
    expect(row.feishuThreadLink).toBeUndefined();
  });
});
