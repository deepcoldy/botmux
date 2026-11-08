import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/session-store.js', () => ({ updateSession: vi.fn() }));
vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(),
  composeRowFromClosed: vi.fn(),
  composeRowFromPersistedActive: vi.fn(),
}));
vi.mock('../src/core/session-message-preview.js', () => ({ buildSessionMessagePreview: vi.fn(() => ({})) }));

import { publishAttentionPatch, raiseDaemonAttention } from '../src/core/session-activity.js';
import { onSessionTaskEvent } from '../src/core/session-task-events.js';
import { deriveSessionTaskStatus } from '../src/core/session-task-status.js';
import { noteTurnStarted } from '../src/core/turn-outcome.js';
import type { DaemonSession } from '../src/core/types.js';

const T0 = 1_800_000_000_000;

function makeDs(agentAttention?: DaemonSession['agentAttention']): DaemonSession {
  return { session: { sessionId: 's1', chatId: 'oc_task' }, agentAttention } as unknown as DaemonSession;
}

describe('steward events from raised hands', () => {
  it('one event per new raise; delivery retries and repeated pushes stay quiet', () => {
    const events: string[] = [];
    const off = onSessionTaskEvent(e => events.push(`${e.chatId}:${e.sessionId}`));
    try {
      const ds = makeDs();
      raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0);
      publishAttentionPatch(ds);
      expect(events).toHaveLength(1);
      // 投递重试：同一次举手反复推送，重试保留首次时刻，不是新的一次；原因变了但时刻没变也还是这一次。
      publishAttentionPatch(ds);
      raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0 + 5_000);
      publishAttentionPatch(ds);
      raiseDaemonAttention(ds, 'blocked', 'durable final output is ambiguous', T0 + 8_000);
      publishAttentionPatch(ds);
      expect(events).toHaveLength(1);
      // 同一原因、但有自己的时刻：后一轮又这样失败了（bot 协作群里前一次的手没人放下），是新的一次。
      ds.agentAttention = { kind: 'blocked', reason: 'final delivery failed', at: T0 + 10_000 };
      publishAttentionPatch(ds);
      expect(events).toHaveLength(2);
      // 清掉之后再举，是新的一次。
      ds.agentAttention = undefined;
      publishAttentionPatch(ds);
      ds.agentAttention = { kind: 'blocked', reason: 'final delivery failed', at: T0 + 20_000 };
      publishAttentionPatch(ds);
      expect(events).toHaveLength(3);
      // agent 每次举手都是一次新的请求；同一次举手期间别的信号（待选仓库、TUI 选择框）再推补丁不算。
      ds.agentAttention = { kind: 'decision', reason: '选方案', at: T0 + 30_000, source: 'agent' };
      publishAttentionPatch(ds);
      publishAttentionPatch(ds);
      ds.agentAttention = { kind: 'decision', reason: '选方案', at: T0 + 40_000, source: 'agent' };
      publishAttentionPatch(ds);
      expect(events).toEqual(Array(5).fill('oc_task:s1'));
    } finally {
      off();
    }
  });
});

describe('raiseDaemonAttention', () => {
  it('a delivery retry with the same reason is not a new raise', () => {
    const ds = makeDs();
    expect(raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0)).toBe(true);
    expect(raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0 + 5_000)).toBe(false);
    expect(ds.agentAttention).toEqual({ kind: 'blocked', reason: 'final delivery failed', at: T0 });
  });

  it('a different reason while the daemon hand is still up keeps the original time', () => {
    const ds = makeDs({ kind: 'blocked', reason: 'topic send blocked', at: T0 });
    expect(raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0 + 5_000)).toBe(true);
    expect(ds.agentAttention).toEqual({ kind: 'blocked', reason: 'final delivery failed', at: T0 });
  });

  it('an agent request is replaced and the daemon raise gets its own time', () => {
    const ds = makeDs({ kind: 'decision', reason: '选方案', at: T0, source: 'agent' });
    expect(raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0 + 5_000)).toBe(true);
    expect(ds.agentAttention).toEqual({ kind: 'blocked', reason: 'final delivery failed', at: T0 + 5_000 });
  });

  it('retries inside the turn that raised keep the first time', () => {
    const ds = makeDs();
    noteTurnStarted(ds, 't1', T0);
    raiseDaemonAttention(ds, 'blocked', 'topic send blocked', T0 + 30_000);
    expect(raiseDaemonAttention(ds, 'blocked', 'topic send blocked', T0 + 35_000)).toBe(false);
    expect(raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0 + 40_000)).toBe(true);
    expect(ds.agentAttention).toEqual({ kind: 'blocked', reason: 'final delivery failed', at: T0 + 30_000 });
  });

  it.each([
    ['the same reason', 'final delivery failed'],
    ['a different reason', 'topic send blocked'],
  ])('a failure in a later turn with %s is a new raise the board still shows', (_label, secondReason) => {
    // Bot-only group: nobody replies, so the first raise is never cleared.
    const ds = makeDs();
    noteTurnStarted(ds, 't1', T0);
    raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0 + 30_000);
    noteTurnStarted(ds, 't2', T0 + 600_000);
    expect(raiseDaemonAttention(ds, 'blocked', secondReason, T0 + 630_000)).toBe(true);
    expect(ds.agentAttention?.at).toBe(T0 + 630_000);
    const status = deriveSessionTaskStatus({
      status: 'idle',
      agentAttention: ds.agentAttention,
      lastMessageAt: T0 + 600_000,
      lastTurn: { turnId: 't2', outcome: 'no_output', at: T0 + 660_000, startedAt: T0 + 600_000 },
    }, T0 + 660_000);
    expect(status).toMatchObject({ kind: 'needs_you', reason: 'interrupted', detail: secondReason });
  });
});
